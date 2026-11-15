import { logger } from '../../utils/logger';

// New users should surface within a minute; balances need to be fresher than that.
export const CACHE_DURATION_USERS_MS = 60000;
export const CACHE_DURATION_WALLETS_MS = 15000;
export const MAX_WALLET_CACHE_SIZE = 100;

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export const apiCache: {
  users?: CacheEntry<User[]>;
  userWallets: Map<string, CacheEntry<Wallet[]>>;
} = {
  userWallets: new Map(),
};

export const isCacheValid = <T>(
  entry: CacheEntry<T> | undefined,
  durationMs: number,
): entry is CacheEntry<T> => {
  if (!entry) return false;
  return Date.now() - entry.timestamp < durationMs;
};

// Held on a shared object so the owning modules can reassign these without
// splitting the single registry the in-flight deduplication depends on.
export const pendingRequests: {
  users: Promise<User[]> | null;
  userWallets: Map<string, Promise<Wallet[]>>;
} = {
  users: null,
  userWallets: new Map(),
};

export const clearApiCache = () => {
  apiCache.users = undefined;
  apiCache.userWallets.clear();
  pendingRequests.users = null;
  pendingRequests.userWallets.clear();
  logger.debug('API cache cleared');
};

export const invalidateWalletCache = (userId?: string) => {
  if (userId) {
    apiCache.userWallets.delete(userId);
    logger.debug(`Wallet cache invalidated for user ${userId}`);
  } else {
    apiCache.userWallets.clear();
    logger.debug('All wallet caches invalidated');
  }
};
