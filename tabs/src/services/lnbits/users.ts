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

// TODO: Implement the actual API call to fetch the allowance.
const getAllowance = async (_userId: string): Promise<Allowance> => {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 (Sunday) to 6 (Saturday)
  const nextPaymentDate = new Date(today);
  nextPaymentDate.setDate(today.getDate() + ((8 - dayOfWeek) % 7 || 7));
  const lastPaymentDate = new Date(today);
  lastPaymentDate.setDate(today.getDate() - ((dayOfWeek + 6) % 7));

  return {
    id: '123',
    name: 'Allowance',
    wallet: '123456789',
    toWallet: '123456789',
    amount: 25000,
    startDate: new Date(),
    endDate: null,
    frequency: 'Monthly',
    nextPaymentDate,
    lastPaymentDate,
    memo: "Don't spend it all at once",
    active: true,
  };
};

export { getAllUsersFromAPI, getUsers, getUser, getAllowance };
