import {
  apiCache,
  CACHE_DURATION_USERS_MS,
  clearApiCache,
  invalidateWalletCache,
  isCacheValid,
  pendingRequests,
} from './cache';

const wallet = (id: string): Wallet => ({
  id,
  admin: '',
  name: `${id} - Private`,
  user: 'user-1',
  adminkey: 'admin-key',
  inkey: 'in-key',
  balance_msat: 0,
  deleted: false,
});

describe('lnbits cache', () => {
  beforeEach(() => {
    clearApiCache();
  });

  describe('isCacheValid', () => {
    test('rejects a missing entry', () => {
      expect(isCacheValid(undefined, CACHE_DURATION_USERS_MS)).toBe(false);
    });

    test('accepts an entry inside the window', () => {
      const entry = { data: [], timestamp: Date.now() };
      expect(isCacheValid(entry, CACHE_DURATION_USERS_MS)).toBe(true);
    });

    test('rejects an entry past the window', () => {
      const entry = {
        data: [],
        timestamp: Date.now() - CACHE_DURATION_USERS_MS - 1,
      };
      expect(isCacheValid(entry, CACHE_DURATION_USERS_MS)).toBe(false);
    });
  });

  describe('clearApiCache', () => {
    test('drops cached users and wallets plus both pending registries', () => {
      apiCache.rawUsers = { data: [{ id: 'user-1' }], timestamp: Date.now() };
      apiCache.userWallets.set('user-1', {
        data: [wallet('wallet-1')],
        timestamp: Date.now(),
      });
      pendingRequests.users = Promise.resolve([]);
      pendingRequests.userWallets.set('user-1', Promise.resolve([]));

      clearApiCache();

      expect(apiCache.rawUsers).toBeUndefined();
      expect(apiCache.userWallets.size).toBe(0);
      expect(pendingRequests.users).toBeNull();
      expect(pendingRequests.userWallets.size).toBe(0);
    });
  });

  describe('invalidateWalletCache', () => {
    beforeEach(() => {
      apiCache.userWallets.set('user-1', {
        data: [wallet('wallet-1')],
        timestamp: Date.now(),
      });
      apiCache.userWallets.set('user-2', {
        data: [wallet('wallet-2')],
        timestamp: Date.now(),
      });
    });

    test('drops only the named user', () => {
      invalidateWalletCache('user-1');

      expect(apiCache.userWallets.has('user-1')).toBe(false);
      expect(apiCache.userWallets.has('user-2')).toBe(true);
    });

    test('drops every user when called without an id', () => {
      invalidateWalletCache();

      expect(apiCache.userWallets.size).toBe(0);
    });

    test('leaves the cached users list alone', () => {
      apiCache.rawUsers = { data: [{ id: 'user-1' }], timestamp: Date.now() };

      invalidateWalletCache();

      expect(apiCache.rawUsers).toBeDefined();
    });
  });
});
