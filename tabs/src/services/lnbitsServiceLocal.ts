import { loginRequest } from './authConfig';
import { msalInstance } from './msalClient';

const API_BASE = '/api/lnbits';
const CACHE_DURATION_USERS_MS = 60_000;
const CACHE_DURATION_WALLETS_MS = 15_000;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface PaymentResult {
  payment_hash: string;
  checking_id?: string;
}

const userCache: { value?: CacheEntry<User[]> } = {};
const walletCache = new Map<string, CacheEntry<Wallet[]>>();

const cacheValid = <T>(entry: CacheEntry<T> | undefined, ttl: number) =>
  Boolean(entry && Date.now() - entry.timestamp < ttl);

const getIdToken = async () => {
  const account =
    msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
  if (!account) {
    throw new Error('Sign in is required');
  }
  const response = await msalInstance.acquireTokenSilent({
    ...loginRequest,
    account,
  });
  if (!response.idToken) {
    throw new Error('Authentication did not return an ID token');
  }
  return response.idToken;
};

const apiRequest = async <T>(
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const token = await getIdToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the status-only message for a non-JSON response.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
};

export const clearApiCache = () => {
  userCache.value = undefined;
  walletCache.clear();
};

export const invalidateWalletCache = (userId?: string) => {
  if (userId) walletCache.delete(userId);
  else walletCache.clear();
};

const getUsers = async (
  filterByExtra: { [key: string]: string } | null = null,
): Promise<User[]> => {
  let users: User[];
  if (cacheValid(userCache.value, CACHE_DURATION_USERS_MS)) {
    users = userCache.value!.data;
  } else {
    users = await apiRequest<User[]>('/users');
    userCache.value = { data: users, timestamp: Date.now() };
  }

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

const getUserWallets = async (userId: string): Promise<Wallet[]> => {
  const cached = walletCache.get(userId);
  if (cacheValid(cached, CACHE_DURATION_WALLETS_MS)) {
    return cached!.data;
  }
  const wallets = await apiRequest<Wallet[]>(
    `/users/${encodeURIComponent(userId)}/wallets`,
  );
  walletCache.set(userId, { data: wallets, timestamp: Date.now() });
  return wallets;
};

const getUser = async (userId: string): Promise<User | null> => {
  const users = await getUsers();
  const user = users.find(candidate => candidate.id === userId);
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

const getWalletName = async (walletId: string) =>
  (await getWalletDetails(walletId)).name;

const getWalletPayments = async (walletId: string): Promise<Transaction[]> =>
  apiRequest<Transaction[]>(
    `/wallets/${encodeURIComponent(walletId)}/payments?limit=100`,
  );

const getWalletPayLinks = async (walletId: string) =>
  apiRequest<unknown>(`/wallets/${encodeURIComponent(walletId)}/paylinks`);

const getWalletId = async (walletId: string) => walletId;

const getInvoicePayment = async (walletId: string, invoice: string) =>
  apiRequest<unknown>(
    `/wallets/${encodeURIComponent(walletId)}/payments/${encodeURIComponent(invoice)}`,
  );

const getWalletTransactionsSince = async (
  walletId: string,
  timestamp: number,
  filterByExtra: { [key: string]: string } | null,
): Promise<Transaction[]> => {
  const transactions = await getWalletPayments(walletId);
  return transactions.filter(transaction => {
    const time =
      typeof transaction.time === 'number'
        ? transaction.time
        : Date.parse(transaction.time) / 1000;
    if (timestamp > 0 && (!Number.isFinite(time) || time < timestamp)) {
      return false;
    }
    if (!filterByExtra) return true;
    return Object.entries(filterByExtra).every(
      ([key, value]) => transaction.extra?.[key] === value,
    );
  });
};

const createInvoice = async (
  walletId: string,
  amount: number,
  memo: string,
): Promise<string> => {
  const result = await apiRequest<{ paymentRequest: string }>(
    `/wallets/${encodeURIComponent(walletId)}/invoices`,
    {
      method: 'POST',
      body: JSON.stringify({ amount, memo }),
    },
  );
  return result.paymentRequest;
};

const payInvoice = async (
  walletId: string,
  paymentRequest: string,
): Promise<PaymentResult> =>
  apiRequest<PaymentResult>(
    `/wallets/${encodeURIComponent(walletId)}/payments`,
    {
      method: 'POST',
      body: JSON.stringify({ paymentRequest }),
    },
  );

const sendZap = async (
  recipientUserId: string,
  amount: number,
  memo: string,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<PaymentResult> =>
  apiRequest<PaymentResult>('/zaps', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ recipientUserId, amount, memo }),
  });

const getNostrRewards = async (stallId: string): Promise<Reward[]> =>
  apiRequest<Reward[]>(`/rewards/${encodeURIComponent(stallId)}`);

const getUserWalletTransactions = async (
  walletId: string,
  filterByExtra: { [key: string]: string } | null,
) => getWalletTransactionsSince(walletId, 0, filterByExtra);

const getAllowance = async (_userId: string): Promise<Allowance> => {
  const today = new Date();
  const dayOfWeek = today.getDay();
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

const getAllPayments = async (
  limit = 1000,
  offset = 0,
  sortby = 'time',
  direction = 'desc',
): Promise<Transaction[]> => {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sortby,
    direction,
  });
  return apiRequest<Transaction[]>(`/payments?${params}`);
};

const getAllWallets = async () => getWallets();
const getAllUsersFromAPI = async () => getUsers();
const getWalletsPaginated = async (userId: string, limit = 100, offset = 0) =>
  (await getUserWallets(userId)).slice(offset, offset + limit);
const getWalletIdByUserId = async (userId: string) =>
  (await getUserWallets(userId))[0]?.id || null;

export {
  createInvoice,
  getAllPayments,
  getAllUsersFromAPI,
  getAllWallets,
  getAllowance,
  getInvoicePayment,
  getNostrRewards,
  getUser,
  getUserWalletTransactions,
  getUserWallets,
  getUsers,
  getWalletBalance,
  getWalletDetails,
  getWalletId,
  getWalletIdByUserId,
  getWalletName,
  getWalletPayLinks,
  getWalletPayments,
  getWallets,
  getWalletsPaginated,
  getWalletTransactionsSince,
  payInvoice,
  sendZap,
};
