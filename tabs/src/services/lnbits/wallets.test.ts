import {
  errorResponse,
  installFetchMock,
  jsonResponse,
} from '../../testUtils/fetchMock';
import { apiCache, clearApiCache, MAX_WALLET_CACHE_SIZE } from './cache';
import {
  getUserWallets,
  getWalletBalance,
  getWallets,
  getWalletsPaginated,
} from './wallets';

jest.mock('./auth', () => ({
  getAccessToken: jest.fn(async () => 'test-token'),
}));

const rawWallet = (id: string, name: string, deleted = false) => ({
  id,
  name,
  user: 'user-1',
  adminkey: 'admin-key',
  inkey: 'in-key',
  balance_msat: 1000,
  deleted,
});

describe('lnbits wallets', () => {
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    mockFetch = installFetchMock();
    clearApiCache();
  });

  describe('getWallets', () => {
    test('returns every wallet when no filter is given', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([rawWallet('w1', 'Alice - Private')]),
      );

      await expect(getWallets()).resolves.toHaveLength(1);
    });

    test('filters by name fragment and by exact id', async () => {
      const wallets = [
        rawWallet('w1', 'Alice - Private'),
        rawWallet('w2', 'Alice - Allowance'),
        rawWallet('w3', 'Bob - Private'),
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse(wallets));

      await expect(getWallets('Private')).resolves.toHaveLength(2);

      mockFetch.mockResolvedValueOnce(jsonResponse(wallets));
      const byId = await getWallets(undefined, 'w2');
      expect(byId?.map(w => w.id)).toEqual(['w2']);
    });

    test('throws when the wallets endpoint fails', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(503));

      await expect(getWallets()).rejects.toThrow('status: 503');
    });
  });

  describe('getWalletBalance', () => {
    test('converts millisatoshis to sats', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ balance: 21000 }));

      await expect(getWalletBalance('in-key')).resolves.toBe(21);
    });

    test('throws when the wallet endpoint fails', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

      await expect(getWalletBalance('in-key')).rejects.toThrow('status: 404');
    });
  });

  describe('getUserWallets', () => {
    test('drops deleted wallets and caches the result', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          rawWallet('w1', 'Alice - Private'),
          rawWallet('w2', 'Alice - Old', true),
        ]),
      );

      const first = await getUserWallets('admin-key', 'user-1');
      const second = await getUserWallets('admin-key', 'user-1');

      expect(first?.map(w => w.id)).toEqual(['w1']);
      expect(second).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('reuses an in-flight request for the same user', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([rawWallet('w1', 'Alice - Private')]),
      );

      const [first, second] = await Promise.all([
        getUserWallets('admin-key', 'user-1'),
        getUserWallets('admin-key', 'user-1'),
      ]);

      expect(second).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('still fetches separately for a different user', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse([rawWallet('w1', 'Alice - Private')]),
      );

      await Promise.all([
        getUserWallets('admin-key', 'user-1'),
        getUserWallets('admin-key', 'user-2'),
      ]);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test('retries after a failure instead of reusing the rejected request', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500));

      await expect(getUserWallets('admin-key', 'user-1')).rejects.toThrow(
        'status: 500',
      );

      mockFetch.mockResolvedValueOnce(
        jsonResponse([rawWallet('w1', 'Alice - Private')]),
      );
      await expect(getUserWallets('admin-key', 'user-1')).resolves.toHaveLength(
        1,
      );
    });

    test('evicts the oldest entry once the cache is full', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));

      for (let i = 0; i < MAX_WALLET_CACHE_SIZE; i += 1) {
        await getUserWallets('admin-key', `user-${i}`);
      }
      expect(apiCache.userWallets.size).toBe(MAX_WALLET_CACHE_SIZE);

      await getUserWallets('admin-key', 'user-overflow');

      expect(apiCache.userWallets.size).toBe(MAX_WALLET_CACHE_SIZE);
      expect(apiCache.userWallets.has('user-0')).toBe(false);
      expect(apiCache.userWallets.has('user-overflow')).toBe(true);
    });
  });

  describe('getWalletsPaginated', () => {
    test('unwraps the paginated payload and drops deleted wallets', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            rawWallet('w1', 'Alice - Private'),
            rawWallet('w2', 'Alice - Old', true),
          ],
          total: 2,
        }),
      );

      const wallets = await getWalletsPaginated('user-1');

      expect(wallets.map(w => w.id)).toEqual(['w1']);
    });

    test('sends limit, offset and user_id as query parameters', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await getWalletsPaginated('user-1', 10, 20);

      const requestedUrl = String(mockFetch.mock.calls[0][0]);
      expect(requestedUrl).toContain('limit=10');
      expect(requestedUrl).toContain('offset=20');
      expect(requestedUrl).toContain('user_id=user-1');
    });
  });
});
