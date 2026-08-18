import {
  getAllPayments,
  getUsers,
  getUserWallets,
} from '../services/lnbitsServiceLocal';

export interface ZapTransfer {
  transaction: Transaction;
  from: User;
  to: User;
}

export interface ZapActivity {
  users: User[];
  transfers: ZapTransfer[];
}

const pairId = (payment: Transaction) =>
  payment.checking_id?.replace(/^internal_/, '') || '';

const transactionTime = (transaction: Transaction): number => {
  const seconds =
    typeof transaction.time === 'number'
      ? transaction.time
      : Date.parse(transaction.time) / 1000;
  return Number.isFinite(seconds) ? seconds : 0;
};

export const fetchZapActivity = async (): Promise<ZapActivity> => {
  const users = await getUsers();
  const walletsByUser = await Promise.all(
    users.map(async user => ({ user, wallets: await getUserWallets(user.id) })),
  );
  const walletOwners = new Map<string, User>();
  const allowanceWalletIds = new Set<string>();
  const privateWalletIds = new Set<string>();

  walletsByUser.forEach(({ user, wallets }) => {
    wallets.forEach(wallet => {
      walletOwners.set(wallet.id, user);
      if (wallet.name === 'Allowance') allowanceWalletIds.add(wallet.id);
      if (wallet.name === 'Private') privateWalletIds.add(wallet.id);
    });
  });

  const payments = await getAllPayments(10_000);
  const paymentsByPair = new Map<string, Transaction[]>();
  payments.forEach(payment => {
    const id = pairId(payment);
    if (!id) return;
    const matches = paymentsByPair.get(id) ?? [];
    matches.push(payment);
    paymentsByPair.set(id, matches);
  });

  const seen = new Set<string>();
  const transfers = payments.flatMap<ZapTransfer>(payment => {
    const id = pairId(payment);
    if (
      !id ||
      seen.has(id) ||
      payment.amount >= 0 ||
      !allowanceWalletIds.has(payment.wallet_id)
    ) {
      return [];
    }

    const received = (paymentsByPair.get(id) ?? []).find(
      candidate =>
        candidate.amount > 0 && privateWalletIds.has(candidate.wallet_id),
    );
    const from = walletOwners.get(payment.wallet_id);
    const to = received ? walletOwners.get(received.wallet_id) : undefined;
    if (!received || !from || !to || from.id === to.id) return [];

    seen.add(id);
    return [{ transaction: payment, from, to }];
  });

  transfers.sort(
    (left, right) =>
      transactionTime(right.transaction) - transactionTime(left.transaction),
  );
  return { users, transfers };
};

export const fetchAllowanceWalletTransactions = async () =>
  (await fetchZapActivity()).transfers.map(transfer => transfer.transaction);
