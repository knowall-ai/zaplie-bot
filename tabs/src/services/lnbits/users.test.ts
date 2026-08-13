import {
  errorResponse,
  installFetchMock,
  jsonResponse,
} from '../../testUtils/fetchMock';
import { clearApiCache } from './cache';
import { getAllUsersFromAPI, getUser, getUsers } from './users';
import { getUserWallets } from './wallets';

jest.mock('./auth', () => ({
  getAccessToken: jest.fn(async () => 'test-token'),
}));

jest.mock('./wallets', () => ({
  getUserWallets: jest.fn(),
}));

const mockGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;

const wallet = (id: string, name: string): Wallet => ({
  id,
  admin: '',
  name,
  user: 'user-1',
  adminkey: 'admin-key',
  inkey: 'in-key',
  balance_msat: 0,
  deleted: false,
});

describe('lnbits users', () => {
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    mockFetch = installFetchMock();
    mockGetUserWallets.mockReset();
    clearApiCache();
  });

  describe('getAllUsersFromAPI', () => {
    test('fetches once and serves the second call from cache', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'user-1', username: 'alice' }] }),
      );

      const first = await getAllUsersFromAPI();
      const second = await getAllUsersFromAPI();

      expect(first).toEqual([{ id: 'user-1', username: 'alice' }]);
      expect(second).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('reuses an in-flight request instead of firing a second one', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'user-1', username: 'alice' }] }),
      );

      const [first, second] = await Promise.all([
        getAllUsersFromAPI(),
        getAllUsersFromAPI(),
      ]);

      expect(second).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('retries after a failure instead of reusing the rejected request', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500));

      await expect(getAllUsersFromAPI()).rejects.toThrow(
        'Failed to fetch users',
      );

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'u' }] }));
      await expect(getAllUsersFromAPI()).resolves.toEqual([{ id: 'u' }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test('throws when the payload carries no data array', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ total: 0 }));

      await expect(getAllUsersFromAPI()).rejects.toThrow('Unexpected payload');
    });
  });

  describe('getUsers', () => {
    test('maps a plain username straight onto displayName', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'user-1', username: 'alice' }] }),
      );

      const users = await getUsers('admin-key', null);

      expect(users).toHaveLength(1);
      expect(users?.[0]).toMatchObject({
        id: 'user-1',
        displayName: 'alice',
        type: 'Teammate',
        privateWallet: null,
        allowanceWallet: null,
      });
    });

    test('turns an email username into a capitalised display name', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'user-1', username: 'wilmer.salazar@knowall.ai' }],
        }),
      );

      const users = await getUsers('admin-key', null);

      expect(users?.[0].displayName).toBe('Wilmer Salazar');
      expect(users?.[0].email).toBe('wilmer.salazar@knowall.ai');
    });

    test('filters by aadObjectId against the external_id field', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: 'user-1', username: 'alice', external_id: 'aad-1' },
            { id: 'user-2', username: 'bob', external_id: 'aad-2' },
          ],
        }),
      );

      const users = await getUsers('admin-key', { aadObjectId: 'aad-2' });

      expect(users).toHaveLength(1);
      expect(users?.[0].id).toBe('user-2');
    });

    test('filters by extra metadata, including a JSON-encoded extra field', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: 'user-1', username: 'alice', extra: { type: 'Guest' } },
            {
              id: 'user-2',
              username: 'bob',
              extra: JSON.stringify({ type: 'Teammate' }),
            },
            { id: 'user-3', username: 'carol' },
          ],
        }),
      );

      const users = await getUsers('admin-key', { type: 'Teammate' });

      expect(users?.map(user => user.id)).toEqual(['user-2']);
    });

    test('returns an empty list when the API has no users', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await expect(getUsers('admin-key', null)).resolves.toEqual([]);
    });
  });

  describe('getUser', () => {
    test.each(['', 'undefined'])(
      'returns null for the %p user id without touching wallets',
      async userId => {
        await expect(getUser('admin-key', userId)).resolves.toBeNull();
        expect(mockGetUserWallets).not.toHaveBeenCalled();
      },
    );

    test('splits private and allowance wallets and derives the display name', async () => {
      mockGetUserWallets.mockResolvedValueOnce([
        wallet('wallet-1', 'Alice - Private'),
        wallet('wallet-2', 'Alice - Allowance'),
      ]);

      const user = await getUser('admin-key', 'user-1');

      expect(user?.displayName).toBe('Alice');
      expect(user?.privateWallet?.id).toBe('wallet-1');
      expect(user?.allowanceWallet?.id).toBe('wallet-2');
    });

    test('returns null when the user has no wallets', async () => {
      mockGetUserWallets.mockResolvedValueOnce([]);

      await expect(getUser('admin-key', 'user-1')).resolves.toBeNull();
    });
  });
});
