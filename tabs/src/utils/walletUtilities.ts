import { getAllPayments } from '../services/lnbits/payments';
import { getUsers } from '../services/lnbits/users';
import { getUserWallets } from '../services/lnbits/wallets';

export interface ZapTransfer {
  transaction: Transaction;
  from: User;
  to: User;
}

export interface ZapActivity {
  users: User[];
  transfers: ZapTransfer[];
  /**
   * True when the payment history ran into `PAYMENT_FETCH_CAP` before the
   * requested window was covered, so older zaps are missing. Callers must say
   * so rather than present a short list as the whole story.
   */
  truncated: boolean;
}

export interface VerifiedZapPayments {
  payments: Transaction[];
  truncated: boolean;
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

// The gateway's /payments route accepts `limit` and `offset` and caps a single
// limit at 10,000 (tabs/backend/lnbitsRoutes.js), so one 10,000-row read is
// both the largest request it will serve and a silent ceiling once an instance
// grows past it. Reading a page at a time lets us stop as soon as the caller's
// window is covered, and lets us say so when it is not.
export const PAYMENT_PAGE_SIZE = 1_000;
export const PAYMENT_FETCH_CAP = 10_000;

// exclude scheduled top-up sweeps
//
// The same exclusion the bot applies in src/services/zapHistoryService.ts. If
// the allowance host wallet is a Private wallet belonging to a directory user,
// every historical sweep pairs cleanly and would otherwise read as one giant
// zap between two real people.
const isAllowanceSweep = (payment: Transaction): boolean =>
  payment.memo?.includes('Weekly Allowance cleared') ?? false;

/**
 * Reads instance-wide payments newest-first, a page at a time.
 *
 * `sinceSeconds` is the oldest moment the caller cares about: paging stops as
 * soon as a page reaches past it, which also guarantees both legs of every pair
 * inside the window are present, since a page boundary can only split a pair
 * that straddles the point we stopped at. Without it the whole history is read,
 * up to `PAYMENT_FETCH_CAP`.
 */
const fetchPayments = async (
  sinceSeconds?: number,
): Promise<{ payments: Transaction[]; truncated: boolean }> => {
  const payments: Transaction[] = [];

  for (
    let offset = 0;
    offset < PAYMENT_FETCH_CAP;
    offset += PAYMENT_PAGE_SIZE
  ) {
    const page = await getAllPayments(PAYMENT_PAGE_SIZE, offset);
    payments.push(...page);

    // A short page is the end of the history, so nothing is missing.
    if (page.length < PAYMENT_PAGE_SIZE) {
      return { payments, truncated: false };
    }
    if (
      sinceSeconds !== undefined &&
      page.some(payment => transactionTime(payment) < sinceSeconds)
    ) {
      return { payments, truncated: false };
    }
  }

  return { payments, truncated: true };
};

/**
 * Every verified Allowance→Private transfer, newest first.
 *
 * A transfer is only emitted when exactly two payments share a `checking_id`,
 * their amounts match, one is an outgoing Allowance leg and the other an
 * incoming Private leg, and the two wallets belong to different people. Any
 * other shape is dropped rather than guessed at.
 */
export const fetchZapActivity = async (
  sinceSeconds?: number,
): Promise<ZapActivity> => {
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

  const { payments, truncated } = await fetchPayments(sinceSeconds);
  const paymentsByPair = new Map<string, Transaction[]>();
  // /payments is a live, newest-first list, so a payment written between two
  // page reads shifts everything down and can hand back a boundary row twice.
  // A duplicated leg would make its pair a group of three and get the whole
  // zap thrown away, so the legs are keyed by the wallet they belong to.
  const seenLegs = new Set<string>();
  payments.forEach(payment => {
    if (isAllowanceSweep(payment)) return;
    const id = pairId(payment);
    if (!id) return;
    const legKey = `${id}|${payment.wallet_id}`;
    if (seenLegs.has(legKey)) return;
    seenLegs.add(legKey);
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
  return { users, transfers, truncated };
};

/**
 * The outgoing Allowance leg of every verified zap, newest first.
 *
 * One row per zap, not two: the matching incoming leg is deliberately left out,
 * so totals built on this do not double-count an internal transfer.
 */
export const fetchVerifiedZapPayments = async (
  sinceSeconds?: number,
): Promise<VerifiedZapPayments> => {
  const { transfers, truncated } = await fetchZapActivity(sinceSeconds);
  return {
    payments: transfers.map(transfer => transfer.transaction),
    truncated,
  };
};
