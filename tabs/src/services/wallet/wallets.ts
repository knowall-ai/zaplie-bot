import { logger } from '../../utils/logger';
import {
  apiCache,
  isCacheValid,
  pendingRequests,
  CACHE_DURATION_WALLETS_MS,
  MAX_WALLET_CACHE_SIZE,
} from './cache';
import { apiRequest } from './gateway';

const getWallets = async (
  filterByName?: string,
  filterById?: string,
): Promise<Wallet[]> => {
  let wallets = await apiRequest<Wallet[]>('/wallets');

  if (filterByName) {
    wallets = wallets.filter(wallet => wallet.name.includes(filterByName));
  }
  if (filterById) {
    wallets = wallets.filter(wallet => wallet.id === filterById);
  }

  return wallets;
};

const getWalletDetails = async (walletId: string): Promise<Wallet> =>
  apiRequest<Wallet>(`/wallets/${encodeURIComponent(walletId)}`);

const getWalletBalance = async (walletId: string): Promise<number> => {
  const result = await apiRequest<{ balance: number }>(
    `/wallets/${encodeURIComponent(walletId)}/balance`,
  );
  return result.balance;
};

const getUserWallets = async (userId: string): Promise<Wallet[]> => {
  const cachedEntry = apiCache.userWallets.get(userId);
  if (isCacheValid(cachedEntry, CACHE_DURATION_WALLETS_MS)) {
    logger.debug(`[Cache HIT] getUserWallets for user ${userId}`);
    return cachedEntry.data;
  }

  const pendingRequest = pendingRequests.userWallets.get(userId);
  if (pendingRequest) {
    logger.debug(
      `[Dedup] Reusing pending getUserWallets request for user ${userId}`,
    );
    return pendingRequest;
  }

  const requestPromise = (async (): Promise<Wallet[]> => {
    try {
      const wallets = await apiRequest<Wallet[]>(
        `/users/${encodeURIComponent(userId)}/wallets`,
      );

      // Limit cache size to prevent unbounded memory growth
      if (apiCache.userWallets.size >= MAX_WALLET_CACHE_SIZE) {
        const firstKey = apiCache.userWallets.keys().next().value;
        if (firstKey) {
          apiCache.userWallets.delete(firstKey);
        }
      }

      apiCache.userWallets.set(userId, {
        data: wallets,
        timestamp: Date.now(),
      });

      return wallets;
    } finally {
      pendingRequests.userWallets.delete(userId);
    }
  })();

  pendingRequests.userWallets.set(userId, requestPromise);
  return requestPromise;
};

const getWalletName = async (walletId: string): Promise<string> =>
  (await getWalletDetails(walletId)).name;

const getWalletPayLinks = async (walletId: string) =>
  apiRequest<unknown>(`/wallets/${encodeURIComponent(walletId)}/paylinks`);

// Wallets are addressed by id everywhere now that the invoice key never
// reaches the browser; the indirection is kept so callers need no change.
const getWalletId = async (walletId: string) => walletId;

const getAllWallets = async (): Promise<Wallet[]> => getWallets();

const getWalletIdByUserId = async (userId: string): Promise<string | null> =>
  (await getUserWallets(userId))[0]?.id || null;

const getWalletsPaginated = async (
  userId: string,
  limit: number = 100,
  offset: number = 0,
): Promise<Wallet[]> =>
  (await getUserWallets(userId)).slice(offset, offset + limit);

export {
  getWallets,
  getWalletDetails,
  getWalletBalance,
  getUserWallets,
  getWalletName,
  getWalletPayLinks,
  getWalletId,
  getAllWallets,
  getWalletIdByUserId,
  getWalletsPaginated,
};
