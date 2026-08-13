import { logger } from '../../utils/logger';

// =============================================================================
// Cache Configuration
// =============================================================================
// TTLs optimized for data change frequency:
// - Users: 60 seconds (new users should appear within a minute)
// - Wallets: 15 seconds (balance updates need to be reasonably fresh)
export const CACHE_DURATION_USERS_MS = 60000; // 1 minute for user list
export const CACHE_DURATION_WALLETS_MS = 15000; // 15 seconds for wallet data
export const MAX_WALLET_CACHE_SIZE = 100; // Limit cache size to prevent memory growth

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// Raw API user data type (before mapping to User)
// Used by getAllUsersFromAPI - mapping to User type is done in getUsers()
export interface RawApiUser {
  id: string;
  username?: string;
  external_id?: string;
  extra?: Record<string, unknown> | string;
}

// Cache stores raw API data to avoid type mismatches
export const apiCache: {
  rawUsers?: CacheEntry<RawApiUser[]>;
  userWallets: Map<string, CacheEntry<Wallet[]>>;
} = {
  userWallets: new Map(),
};

// Helper to check if cache is valid with configurable duration
export const isCacheValid = <T>(
  entry: CacheEntry<T> | undefined,
  durationMs: number,
): entry is CacheEntry<T> => {
  if (!entry) return false;
  return Date.now() - entry.timestamp < durationMs;
};

// Pending promises to prevent duplicate concurrent requests.
// Held on a shared object so the modules that own each request can reassign
// them without losing the single registry the deduplication relies on.
export const pendingRequests: {
  users: Promise<RawApiUser[]> | null;
  userWallets: Map<string, Promise<Wallet[] | null>>;
} = {
  users: null,
  userWallets: new Map(),
};

// Clear cache function - call on logout or account switch
export const clearApiCache = () => {
  apiCache.rawUsers = undefined;
  apiCache.userWallets.clear();
  pendingRequests.users = null;
  pendingRequests.userWallets.clear();
  logger.debug('API cache cleared');
};

// Invalidate wallet cache for a specific user (call after transactions)
export const invalidateWalletCache = (userId?: string) => {
  if (userId) {
    apiCache.userWallets.delete(userId);
    logger.debug(`Wallet cache invalidated for user ${userId}`);
  } else {
    apiCache.userWallets.clear();
    logger.debug('All wallet caches invalidated');
  }
};
