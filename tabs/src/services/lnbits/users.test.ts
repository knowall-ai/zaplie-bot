import { clearApiCache } from './cache';
import { apiRequest } from './gateway';
import { getAllUsersFromAPI, getUser, getUsers } from './users';
import { getUserWallets } from './wallets';

jest.mock('./gateway', () => ({
  apiRequest: jest.fn(),
}));

jest.mock('./wallets', () => ({
  getUserWallets: jest.fn(),
}));

const mockApiRequest = apiRequest as jest.MockedFunction<typeof apiRequest>;
const mockGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;

const user = (id: string, aadObjectId: string): User => ({
  id,
  displayName: id,
  profileImg: '',
  aadObjectId,
  email: `${id}@example.com`,
  type: 'Teammate',
  privateWallet: null,
  allowanceWallet: null,
});

const wallet = (id: string, name: string): Wallet => ({
  id,
  name,
  user: 'user-1',
  balance_msat: 0,
  deleted: false,
});

describe('lnbits users', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
    mockGetUserWallets.mockReset();
    clearApiCache();
  });

  describe('getAllUsersFromAPI', () => {
    test('reads the gateway and serves the second call from cache', async () => {
      mockApiRequest.mockResolvedValue([user('user-1', 'aad-1')]);

      await getAllUsersFromAPI();
      await getAllUsersFromAPI();

      expect(mockApiRequest).toHaveBeenCalledTimes(1);
      expect(mockApiRequest).toHaveBeenCalledWith('/users');
    });

    test('de-duplicates concurrent requests', async () => {
      mockApiRequest.mockResolvedValue([user('user-1', 'aad-1')]);

      await Promise.all([getAllUsersFromAPI(), getAllUsersFromAPI()]);

      expect(mockApiRequest).toHaveBeenCalledTimes(1);
    });

    test('clears the pending request when the gateway fails', async () => {
      mockApiRequest.mockRejectedValueOnce(new Error('gateway down'));

      await expect(getAllUsersFromAPI()).rejects.toThrow('gateway down');

      mockApiRequest.mockResolvedValueOnce([user('user-1', 'aad-1')]);
      await expect(getAllUsersFromAPI()).resolves.toHaveLength(1);
    });
  });

  describe('getUsers', () => {
    test('returns every user when no filter is given', async () => {
      mockApiRequest.mockResolvedValue([
        user('user-1', 'aad-1'),
        user('user-2', 'aad-2'),
      ]);

      await expect(getUsers(null)).resolves.toHaveLength(2);
      await expect(getUsers({})).resolves.toHaveLength(2);
    });

    test('filters by aadObjectId', async () => {
      mockApiRequest.mockResolvedValue([
        user('user-1', 'aad-1'),
        user('user-2', 'aad-2'),
      ]);

      const users = await getUsers({ aadObjectId: 'aad-2' });

      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('user-2');
    });

    test('filters by any other user field', async () => {
      mockApiRequest.mockResolvedValue([
        user('user-1', 'aad-1'),
        { ...user('user-2', 'aad-2'), type: 'Guest' as UserType },
      ]);

      const users = await getUsers({ type: 'Guest' });

      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('user-2');
    });
  });

  describe('getUser', () => {
    test('attaches the private and allowance wallets', async () => {
      mockApiRequest.mockResolvedValue([user('user-1', 'aad-1')]);
      mockGetUserWallets.mockResolvedValue([
        wallet('wallet-1', 'Alice - Private'),
        wallet('wallet-2', 'Alice - Allowance'),
      ]);

      const result = await getUser('user-1');

      expect(result?.privateWallet?.id).toBe('wallet-1');
      expect(result?.allowanceWallet?.id).toBe('wallet-2');
    });

    test('returns null for an unknown user', async () => {
      mockApiRequest.mockResolvedValue([user('user-1', 'aad-1')]);

      await expect(getUser('user-9')).resolves.toBeNull();
      expect(mockGetUserWallets).not.toHaveBeenCalled();
    });

    test('returns null without calling the gateway for an empty id', async () => {
      await expect(getUser('')).resolves.toBeNull();
      expect(mockApiRequest).not.toHaveBeenCalled();
    });
  });
});
