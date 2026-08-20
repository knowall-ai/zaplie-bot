import { logger } from '../../utils/logger';
import {
  apiCache,
  isCacheValid,
  pendingRequests,
  CACHE_DURATION_USERS_MS,
} from './cache';
import { apiRequest } from './gateway';
import { getUserWallets } from './wallets';

// The gateway returns users already mapped to the User shape, so no LNbits
// payload reaches the browser.
const getAllUsersFromAPI = async (): Promise<User[]> => {
  if (isCacheValid(apiCache.users, CACHE_DURATION_USERS_MS)) {
    logger.debug('[Cache HIT] getAllUsersFromAPI');
    return apiCache.users.data;
  }

  const pendingUsersRequest = pendingRequests.users;
  if (pendingUsersRequest) {
    logger.debug('[Dedup] Reusing pending getAllUsersFromAPI request');
    return pendingUsersRequest;
  }

  const usersRequest = (async (): Promise<User[]> => {
    try {
      const users = await apiRequest<User[]>('/users');
      apiCache.users = { data: users, timestamp: Date.now() };
      return users;
    } finally {
      pendingRequests.users = null;
    }
  })();

  pendingRequests.users = usersRequest;
  return usersRequest;
};

const getUsers = async (
  filterByExtra: { [key: string]: string } | null = null,
): Promise<User[]> => {
  const users = await getAllUsersFromAPI();

  if (!filterByExtra || Object.keys(filterByExtra).length === 0) {
    return users;
  }

  return users.filter(user =>
    Object.entries(filterByExtra).every(([key, value]) => {
      if (key === 'aadObjectId') return user.aadObjectId === value;
      return (user as unknown as Record<string, unknown>)[key] === value;
    }),
  );
};

const getUser = async (userId: string): Promise<User | null> => {
  if (!userId || userId === 'undefined') {
    return null;
  }

  const user = (await getUsers()).find(candidate => candidate.id === userId);
  if (!user) return null;

  const wallets = await getUserWallets(userId);
  return {
    ...user,
    privateWallet:
      wallets.find(wallet => wallet.name.toLowerCase().includes('private')) ||
      null,
    allowanceWallet:
      wallets.find(wallet => wallet.name.toLowerCase().includes('allowance')) ||
      null,
  };
};

// The allowance schedule lives in the bot's top-up job and the gateway exposes
// no route for it, so reporting none beats inventing an amount and a date.
const getAllowance = async (_userId: string): Promise<Allowance | null> => null;

export { getAllUsersFromAPI, getUsers, getUser, getAllowance };
