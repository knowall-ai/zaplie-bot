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

export const pairId = (payment: Transaction) =>
  payment.checking_id?.replace(/^internal_/, '') || '';

const walletType = (wallet: Wallet): 'allowance' | 'private' | null => {
  const name = wallet.name.trim().toLowerCase();
  if (name === 'allowance') return 'allowance';
  if (name === 'private') return 'private';
  return null;
};

export const transactionTime = (transaction: Transaction): number => {
  const seconds =
    typeof transaction.time === 'number'
      ? transaction.time
      : Date.parse(transaction.time) / 1000;
  return Number.isFinite(seconds) ? seconds : Number.NEGATIVE_INFINITY;
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
      const existingOwner = walletOwners.get(wallet.id);
      if (existingOwner && existingOwner.id !== user.id) {
        throw new Error(`Wallet ${wallet.id} has conflicting owners.`);
      }

      walletOwners.set(wallet.id, user);
      const type = walletType(wallet);
      if (type === 'allowance') allowanceWalletIds.add(wallet.id);
      if (type === 'private') privateWalletIds.add(wallet.id);
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

  const transfers = Array.from(paymentsByPair.values()).flatMap<ZapTransfer>(
    pairedPayments => {
      if (pairedPayments.length !== 2) return [];

      const outgoing = pairedPayments.filter(
        payment =>
          payment.amount < 0 && allowanceWalletIds.has(payment.wallet_id),
      );
      const incoming = pairedPayments.filter(
        payment =>
          payment.amount > 0 && privateWalletIds.has(payment.wallet_id),
      );
      if (outgoing.length !== 1 || incoming.length !== 1) return [];
      if (Math.abs(outgoing[0].amount) !== incoming[0].amount) return [];

      const from = walletOwners.get(outgoing[0].wallet_id);
      const to = walletOwners.get(incoming[0].wallet_id);
      if (!from || !to || from.id === to.id) return [];

      return [{ transaction: outgoing[0], from, to }];
    },
  );

  transfers.sort(
    (left, right) =>
      transactionTime(right.transaction) - transactionTime(left.transaction),
  );
  return { users, transfers };
};

export const fetchAllowanceWalletTransactions = async () =>
  (await fetchZapActivity()).transfers.map(transfer => transfer.transaction);
