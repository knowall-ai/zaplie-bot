// zapHistoryService.ts
//
// Reconstructs "who zapped whom, when, why, how much" from raw LNbits payments.
//
// LNbits payments don't reliably carry `extra.tag === 'zap'` in practice (see
// tabs/src/utils/walletUtilities.ts, which documents and abandons that filter).
// The pattern that does work in production, ported from
// tabs/src/components/FeedList.tsx: identify wallets by name convention
// (Allowance = sender, Private = receiver), keep outgoing Allowance payments,
// and cross-reference by checking_id against the receiving side to confirm it
// landed in a Private wallet.

import { getUsers, getUserWallets, getPayments } from './lnbitsService';

const adminKey = process.env.LNBITS_ADMINKEY as string;

const WALLET_NAME_ALLOWANCE = 'Allowance';
const WALLET_NAME_PRIVATE = 'Private';

const isAllowanceWallet = (walletName: string): boolean =>
  walletName?.toLowerCase() === WALLET_NAME_ALLOWANCE.toLowerCase();

const isPrivateWallet = (walletName: string): boolean =>
  walletName?.toLowerCase() === WALLET_NAME_PRIVATE.toLowerCase();

const parseTransactionTime = (timestamp: number | string): Date | null => {
  if (typeof timestamp === 'number') {
    return new Date(timestamp * 1000);
  }
  if (typeof timestamp === 'string') {
    const date = new Date(timestamp);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
};

const cleanCheckingId = (checkingId: string | undefined): string =>
  checkingId?.replace('internal_', '') || '';

export interface ZapActivity {
  from: User | null;
  to: User | null;
  amountSats: number;
  memo: string;
  time: Date;
}

export interface GetRecentZapsOptions {
  limit?: number;
  sinceTimestamp?: number; // Unix seconds
  userAadObjectId?: string; // matches zaps where the user is either sender or receiver
}

const DEFAULT_LIMIT = 50;

export async function getRecentZaps(
  options: GetRecentZapsOptions = {},
): Promise<ZapActivity[]> {
  const { limit = DEFAULT_LIMIT, sinceTimestamp, userAadObjectId } = options;

  const users = await getUsers(adminKey, null);
  if (!users || users.length === 0) {
    return [];
  }

  const walletsByUser = await Promise.all(
    users.map(async user => ({
      user,
      wallets: (await getUserWallets(adminKey, user.id)) || [],
    })),
  );

  const walletToUser = new Map<string, User>();
  const allowanceWallets: Wallet[] = [];
  const privateWalletIds = new Set<string>();
  const relevantWallets: Wallet[] = [];

  for (const { user, wallets } of walletsByUser) {
    for (const wallet of wallets) {
      walletToUser.set(wallet.id, user);
      if (isAllowanceWallet(wallet.name)) {
        allowanceWallets.push(wallet);
        relevantWallets.push(wallet);
      } else if (isPrivateWallet(wallet.name)) {
        privateWalletIds.add(wallet.id);
        relevantWallets.push(wallet);
      }
    }
  }

  const allowanceWalletIds = new Set(allowanceWallets.map(w => w.id));

  const paymentsPerWallet = await Promise.all(
    relevantWallets.map(async wallet => {
      try {
        const payments = await getPayments(wallet.inkey);
        return (payments || []) as Transaction[];
      } catch (error) {
        console.error(
          `getRecentZaps: failed to fetch payments for wallet ${wallet.id}:`,
          error,
        );
        return [] as Transaction[];
      }
    }),
  );

  // tsconfig targets es2017, so flatten without Array.prototype.flat (es2019).
  const allPayments: Transaction[] = ([] as Transaction[]).concat(...paymentsPerWallet);

  // Internal transfers write both the debit and credit side under the same
  // checking_id (one side prefixed with "internal_") — index both so either
  // side can find its counterpart.
  const paymentsByCheckingId = new Map<string, Transaction[]>();
  for (const payment of allPayments) {
    const cleanId = cleanCheckingId(payment.checking_id);
    if (!cleanId) continue;
    const existing = paymentsByCheckingId.get(cleanId) || [];
    existing.push(payment);
    paymentsByCheckingId.set(cleanId, existing);
  }

  const findReceivingPayment = (payment: Transaction): Transaction | undefined => {
    const cleanId = cleanCheckingId(payment.checking_id);
    const matches = paymentsByCheckingId.get(cleanId) || [];
    return matches.find(p => p.wallet_id !== payment.wallet_id && p.amount > 0);
  };

  const zapPayments = allPayments.filter(payment => {
    if (!allowanceWalletIds.has(payment.wallet_id)) return false; // must originate from an Allowance wallet
    if (payment.amount >= 0) return false; // must be outgoing
    if (payment.memo?.includes('Weekly Allowance cleared')) return false; // exclude scheduled top-up sweeps

    const receivingPayment = findReceivingPayment(payment);
    return !!receivingPayment && privateWalletIds.has(receivingPayment.wallet_id);
  });

  // Both sides of an internal transfer can surface once per wallet fetched,
  // so dedupe by checking_id before mapping to ZapActivity.
  const seenCheckingIds = new Set<string>();
  const dedupedPayments = zapPayments.filter(payment => {
    const cleanId = cleanCheckingId(payment.checking_id);
    if (!cleanId) return true;
    if (seenCheckingIds.has(cleanId)) return false;
    seenCheckingIds.add(cleanId);
    return true;
  });

  let activity: ZapActivity[] = dedupedPayments.map(payment => {
    const receivingPayment = findReceivingPayment(payment);
    const time = parseTransactionTime(payment.time) ?? new Date(0);
    return {
      from: walletToUser.get(payment.wallet_id) ?? null,
      to: receivingPayment ? walletToUser.get(receivingPayment.wallet_id) ?? null : null,
      amountSats: Math.abs(Math.floor(payment.amount / 1000)),
      memo: payment.memo ?? '',
      time,
    };
  });

  if (sinceTimestamp) {
    activity = activity.filter(
      entry => Math.floor(entry.time.getTime() / 1000) >= sinceTimestamp,
    );
  }

  if (userAadObjectId) {
    activity = activity.filter(
      entry =>
        entry.from?.aadObjectId === userAadObjectId ||
        entry.to?.aadObjectId === userAadObjectId,
    );
  }

  activity.sort((a, b) => b.time.getTime() - a.time.getTime());

  return activity.slice(0, limit);
}
