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

import {
  getUsers,
  getUserWallets,
  getPayments,
  getAllPaymentsPage,
  PaginatedPaymentsUnsupportedError,
} from './lnbitsService';
import { isAllowanceWallet, isPrivateWallet } from './walletNames';

const adminKey = process.env.LNBITS_ADMINKEY as string;

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

// A team-wide read fans out one LNbits request per user and one per relevant
// wallet, so an unbounded Promise.all grows with head-count and can exhaust the
// connection pool or trip LNbits' rate limiter. Cap the in-flight requests
// instead: still parallel, but with a ceiling that does not depend on team size.
export const MAX_CONCURRENT_LNBITS_REQUESTS = 8;

// Page size for payment reads. Both paths below page until a short page comes
// back, so this is a request-size knob, not a ceiling on history: nothing is
// dropped for being old. That matters more than it looks — truncating a
// *receiving* Private wallet breaks the checking_id cross-reference below, so
// the sender's zap disappears from the totals with nothing logged anywhere.
export const PAYMENTS_PAGE_SIZE = 1000;

// A stop so a paging bug cannot spin forever against a live instance. Hitting
// it is reported through `partial`, never swallowed.
export const MAX_PAYMENT_PAGES = 100;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  // Each worker drains the shared queue; a rejection propagates exactly as it
  // would from Promise.all, so caller-visible error behaviour is unchanged.
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

// A read that either produced a value or failed. Team-wide reads settle each
// item instead of rejecting the whole batch, so one rate-limited wallet costs
// that wallet rather than the entire leaderboard — but the failure is counted
// and surfaced, never quietly treated as "no payments".
// A single shape rather than a discriminated union: this project compiles with
// `strict` off, where narrowing on a literal boolean discriminant is unreliable.
interface Settled<R> {
  ok: boolean;
  value?: R;
  error?: unknown;
}

const settle = async <R>(work: () => Promise<R>): Promise<Settled<R>> => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
};

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

// What a team-wide read could not see. `partial` is the bit callers must act
// on: it means the numbers below are a floor, not a total, so the assistant can
// hedge instead of stating an incomplete ranking as fact.
export interface ZapReadCoverage {
  partial: boolean;
  skippedUsers: number; // users whose wallet list could not be read
  skippedWallets: number; // wallets whose payments could not be read
  truncated: boolean; // paging stopped at MAX_PAYMENT_PAGES
}

export interface ZapActivityResult extends ZapReadCoverage {
  zaps: ZapActivity[];
}

const DEFAULT_LIMIT = 50;

// Page the instance-wide payments endpoint until it runs out. One request per
// page for the whole team, rather than one (or more) per wallet.
const readAllPaymentsPaged = async (): Promise<{
  payments: Transaction[];
  truncated: boolean;
}> => {
  const payments: Transaction[] = [];
  for (let page = 0; page < MAX_PAYMENT_PAGES; page += 1) {
    const batch = await getAllPaymentsPage(
      PAYMENTS_PAGE_SIZE,
      page * PAYMENTS_PAGE_SIZE,
    );
    payments.push(...batch);
    if (batch.length < PAYMENTS_PAGE_SIZE) {
      return { payments, truncated: false };
    }
  }
  console.warn(
    `getRecentZaps: stopped after ${MAX_PAYMENT_PAGES} pages of payments; ` +
      'results are incomplete.',
  );
  return { payments, truncated: true };
};

// Fallback for instances without the paginated all-payments endpoint: page each
// wallet with its own invoice key, bounded by the same concurrency pool. A
// wallet that fails is skipped and counted, not scored as zero.
const readWalletPaymentsPaged = async (
  wallets: Wallet[],
): Promise<{
  payments: Transaction[];
  skippedWallets: number;
  truncated: boolean;
}> => {
  let truncated = false;
  const results = await mapWithConcurrency(
    wallets,
    MAX_CONCURRENT_LNBITS_REQUESTS,
    wallet =>
      settle(async () => {
        const collected: Transaction[] = [];
        for (let page = 0; page < MAX_PAYMENT_PAGES; page += 1) {
          const batch = await getPayments(
            wallet.inkey,
            PAYMENTS_PAGE_SIZE,
            page * PAYMENTS_PAGE_SIZE,
          );
          const rows = batch || [];
          collected.push(...rows);
          if (rows.length < PAYMENTS_PAGE_SIZE) return collected;
        }
        truncated = true;
        console.warn(
          `getRecentZaps: stopped after ${MAX_PAYMENT_PAGES} pages for wallet ` +
            `${wallet.id}; its older payments are not counted.`,
        );
        return collected;
      }),
  );

  const payments: Transaction[] = [];
  let skippedWallets = 0;
  for (const [index, result] of results.entries()) {
    if (result.ok) {
      payments.push(...(result.value || []));
    } else {
      skippedWallets += 1;
      console.error(
        `getRecentZaps: failed to fetch payments for wallet ${wallets[index].id}:`,
        result.error,
      );
    }
  }
  return { payments, skippedWallets, truncated };
};

// Prefer the instance-wide paginated read: a handful of requests instead of one
// per wallet, and no per-wallet truncation to break the checking_id
// cross-reference. Instances without that endpoint page each wallet instead.
const readPayments = async (
  relevantWallets: Wallet[],
): Promise<{
  payments: Transaction[];
  skippedWallets: number;
  truncated: boolean;
}> => {
  try {
    const paged = await readAllPaymentsPaged();
    return {
      payments: paged.payments,
      skippedWallets: 0,
      truncated: paged.truncated,
    };
  } catch (error) {
    if (!(error instanceof PaginatedPaymentsUnsupportedError)) throw error;
    console.warn(
      'getRecentZaps: falling back to per-wallet payment paging:',
      error,
    );
    return readWalletPaymentsPaged(relevantWallets);
  }
};

export async function getZapActivity(
  options: GetRecentZapsOptions = {},
): Promise<ZapActivityResult> {
  const { limit = DEFAULT_LIMIT, sinceTimestamp, userAadObjectId } = options;

  const empty = {
    zaps: [] as ZapActivity[],
    partial: false,
    skippedUsers: 0,
    skippedWallets: 0,
    truncated: false,
  };

  const users = await getUsers(adminKey, null);
  if (!users || users.length === 0) {
    return empty;
  }

  // One user's unreadable wallet list must not reject the whole ranking, but it
  // does mean that user's zaps are missing — count it rather than hide it.
  const walletResults = await mapWithConcurrency(
    users,
    MAX_CONCURRENT_LNBITS_REQUESTS,
    user => settle(async () => (await getUserWallets(adminKey, user.id)) || []),
  );

  let skippedUsers = 0;
  const walletsByUser: { user: User; wallets: Wallet[] }[] = [];
  for (const [index, result] of walletResults.entries()) {
    if (result.ok) {
      walletsByUser.push({ user: users[index], wallets: result.value || [] });
    } else {
      skippedUsers += 1;
      console.error(
        `getRecentZaps: failed to fetch wallets for user ${users[index].id}:`,
        result.error,
      );
    }
  }

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

  const {
    payments: allPayments,
    skippedWallets,
    truncated,
  } = await readPayments(relevantWallets);

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

  const findReceivingPayment = (
    payment: Transaction,
  ): Transaction | undefined => {
    const cleanId = cleanCheckingId(payment.checking_id);
    const matches = paymentsByCheckingId.get(cleanId) || [];
    return matches.find(p => p.wallet_id !== payment.wallet_id && p.amount > 0);
  };

  const zapPayments = allPayments.filter(payment => {
    if (!allowanceWalletIds.has(payment.wallet_id)) return false; // must originate from an Allowance wallet
    if (payment.amount >= 0) return false; // must be outgoing
    if (payment.memo?.includes('Weekly Allowance cleared')) return false; // exclude scheduled top-up sweeps

    const receivingPayment = findReceivingPayment(payment);
    return (
      !!receivingPayment && privateWalletIds.has(receivingPayment.wallet_id)
    );
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
      to: receivingPayment
        ? (walletToUser.get(receivingPayment.wallet_id) ?? null)
        : null,
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

  return {
    zaps: activity.slice(0, limit),
    partial: skippedUsers > 0 || skippedWallets > 0 || truncated,
    skippedUsers,
    skippedWallets,
    truncated,
  };
}

// Back-compatible view for callers that only want the zaps. Prefer
// getZapActivity() where the caller can tell the user that a read was partial.
export async function getRecentZaps(
  options: GetRecentZapsOptions = {},
): Promise<ZapActivity[]> {
  return (await getZapActivity(options)).zaps;
}

export interface ZapLeaderboardEntry {
  user: User;
  zappedSats: number;
}

export interface ZapLeaderboard extends ZapReadCoverage {
  entries: ZapLeaderboardEntry[];
}

// Ranks recognition given, not money held: a Private wallet is the owner's own
// balance (and may one day be an external wallet we cannot read), so only zaps
// sent out of Allowance wallets count.
//
// This is the same *measure* as the portal leaderboard
// (tabs/src/components/Leaderboard.tsx) — sats sent, ranked per user — but it is
// stricter about what counts: the portal sums every outgoing payment from any
// mapped wallet minus "Weekly Allowance cleared", while this reuses
// getRecentZaps(), which additionally requires the payment to leave an Allowance
// wallet and to land in a Private wallet (cross-referenced by checking_id). The
// bot therefore excludes outgoing payments the portal would still count, such as
// a withdrawal to an external invoice. Expect small differences until the two
// converge.
export async function getZapLeaderboard(
  options: { sinceTimestamp?: number } = {},
): Promise<ZapLeaderboard> {
  const activity = await getZapActivity({
    limit: Number.MAX_SAFE_INTEGER,
    sinceTimestamp: options.sinceTimestamp,
  });

  const totalsByUserId = new Map<string, ZapLeaderboardEntry>();
  for (const zap of activity.zaps) {
    // A sending wallet that resolves to no user cannot be ranked.
    if (!zap.from) continue;
    // Zapping yourself is not recognition, and counting it would let anyone
    // top the board by moving their own allowance into their own Private
    // wallet. Skipped here rather than in getZapActivity, because the feed
    // and a user's own history should still show the movement.
    if (zap.to && zap.to.id === zap.from.id) continue;
    const entry = totalsByUserId.get(zap.from.id);
    if (entry) {
      entry.zappedSats += zap.amountSats;
    } else {
      totalsByUserId.set(zap.from.id, {
        user: zap.from,
        zappedSats: zap.amountSats,
      });
    }
  }

  return {
    entries: Array.from(totalsByUserId.values()).sort(
      (a, b) =>
        b.zappedSats - a.zappedSats ||
        a.user.displayName.localeCompare(b.user.displayName),
    ),
    partial: activity.partial,
    skippedUsers: activity.skippedUsers,
    skippedWallets: activity.skippedWallets,
    truncated: activity.truncated,
  };
}
