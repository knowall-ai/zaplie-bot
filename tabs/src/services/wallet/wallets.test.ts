import { apiCache, clearApiCache, MAX_WALLET_CACHE_SIZE } from './cache';
import { apiRequest } from './gateway';
import {
  getUserWallets,
  getWalletBalance,
  getWalletDetails,
  getWalletIdByUserId,
  getWalletName,
  getWallets,
  getWalletsPaginated,
} from './wallets';

jest.mock('./gateway', () => ({
  apiRequest: jest.fn(),
}));

const mockApiRequest = apiRequest as jest.MockedFunction<typeof apiRequest>;

const wallet = (id: string, name = `${id} - Private`): Wallet => ({
  id,
  name,
  user: 'user-1',
  balance_msat: 0,
  deleted: false,
});

describe('lnbits wallets', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
    clearApiCache();
  });

  describe('getWallets', () => {
    test('reads the gateway wallet list', async () => {
      mockApiRequest.mockResolvedValueOnce([wallet('w1')]);

      await expect(getWallets()).resolves.toEqual([wallet('w1')]);
      expect(mockApiRequest).toHaveBeenCalledWith('/wallets');
    });

    test('filters by name and id', async () => {
      mockApiRequest.mockResolvedValue([
        wallet('w1', 'Alice - Private'),
        wallet('w2', 'Alice - Allowance'),
      ]);

      await expect(getWallets('Allowance')).resolves.toHaveLength(1);
      await expect(getWallets(undefined, 'w1')).resolves.toHaveLength(1);
    });
  });

  describe('getWalletDetails and getWalletName', () => {
    test('address the wallet by id', async () => {
      mockApiRequest.mockResolvedValue(wallet('w1', 'Alice - Private'));

      await expect(getWalletDetails('w1')).resolves.toEqual(
        wallet('w1', 'Alice - Private'),
      );
      await expect(getWalletName('w1')).resolves.toBe('Alice - Private');
      expect(mockApiRequest).toHaveBeenCalledWith('/wallets/w1');
    });
  });

  describe('getWalletBalance', () => {
    test('returns the balance the gateway reports', async () => {
      mockApiRequest.mockResolvedValueOnce({ balance: 21 });

      await expect(getWalletBalance('w1')).resolves.toBe(21);
      expect(mockApiRequest).toHaveBeenCalledWith('/wallets/w1/balance');
    });
  });

  describe('getUserWallets', () => {
    test('fetches once and serves the second call from cache', async () => {
      mockApiRequest.mockResolvedValue([wallet('w1')]);

      await getUserWallets('user-1');
      await getUserWallets('user-1');

      expect(mockApiRequest).toHaveBeenCalledTimes(1);
      expect(mockApiRequest).toHaveBeenCalledWith('/users/user-1/wallets');
    });

    test('de-duplicates concurrent requests for the same user', async () => {
      mockApiRequest.mockResolvedValue([wallet('w1')]);

      await Promise.all([getUserWallets('user-1'), getUserWallets('user-1')]);

      expect(mockApiRequest).toHaveBeenCalledTimes(1);
    });

    test('keeps separate requests per user', async () => {
      mockApiRequest.mockResolvedValue([wallet('w1')]);

      await Promise.all([getUserWallets('user-1'), getUserWallets('user-2')]);

      expect(mockApiRequest).toHaveBeenCalledTimes(2);
    });

    test('drops the pending request when the gateway fails', async () => {
      mockApiRequest.mockRejectedValueOnce(new Error('gateway down'));

      await expect(getUserWallets('user-1')).rejects.toThrow('gateway down');

      mockApiRequest.mockResolvedValueOnce([wallet('w1')]);
      await expect(getUserWallets('user-1')).resolves.toHaveLength(1);
    });

    test('evicts the oldest entry once the cache is full', async () => {
      mockApiRequest.mockResolvedValue([wallet('w1')]);

      for (let i = 0; i < MAX_WALLET_CACHE_SIZE; i += 1) {
        await getUserWallets(`user-${i}`);
      }
      await getUserWallets('user-overflow');

      expect(apiCache.userWallets.size).toBe(MAX_WALLET_CACHE_SIZE);
      expect(apiCache.userWallets.has('user-0')).toBe(false);
    });
  });

  describe('derived helpers', () => {
    test('getWalletIdByUserId returns the first wallet id', async () => {
      mockApiRequest.mockResolvedValueOnce([wallet('w1'), wallet('w2')]);

      await expect(getWalletIdByUserId('user-1')).resolves.toBe('w1');
    });

    test('getWalletIdByUserId returns null without wallets', async () => {
      mockApiRequest.mockResolvedValueOnce([]);

      await expect(getWalletIdByUserId('user-1')).resolves.toBeNull();
    });

    test('getWalletsPaginated slices the cached list', async () => {
      mockApiRequest.mockResolvedValueOnce([
        wallet('w1'),
        wallet('w2'),
        wallet('w3'),
      ]);

      await expect(getWalletsPaginated('user-1', 1, 1)).resolves.toEqual([
        wallet('w2'),
      ]);
    });
  });
});
