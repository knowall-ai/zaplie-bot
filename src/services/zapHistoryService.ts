// zapHistoryService.ts
//
// "Who zapped whom, when, why, how much", from Zaplie's own record of every
// zap it paid (the portal's zap records, src/services/peopleDirectory.ts
// listZaps). Wallets are reached over NWC, which carries no LNbits `extra`,
// and each person's Private wallet is their own, so Zaplie's record is the
// source of truth: one entry per payment, keyed by payment hash, naming both
// people by Entra id. Automation rewards are recorded too and excluded here.

import { listPeople, listZaps } from './peopleDirectory';

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

export async function getZapActivity(
  options: GetRecentZapsOptions = {},
): Promise<ZapActivityResult> {
  const { limit = DEFAULT_LIMIT, sinceTimestamp, userAadObjectId } = options;

  const [users, records] = await Promise.all([
    listPeople(),
    listZaps(sinceTimestamp),
  ]);
  const userById = new Map(users.map(user => [user.id.toLowerCase(), user]));
  const person = (oid: string | null): User | null =>
    oid ? (userById.get(oid.toLowerCase()) ?? null) : null;

  let activity: ZapActivity[] = records
    .filter(record => record.kind === 'zap')
    .map(record => ({
      from: person(record.from.oid),
      to: person(record.to.oid),
      amountSats: Math.floor(record.amountSats),
      memo: record.memo ?? '',
      time: new Date(record.time * 1000),
    }));

  if (sinceTimestamp) {
    activity = activity.filter(
      entry => Math.floor(entry.time.getTime() / 1000) >= sinceTimestamp,
    );
  }

  if (userAadObjectId) {
    const wanted = userAadObjectId.toLowerCase();
    activity = activity.filter(
      entry =>
        entry.from?.aadObjectId === wanted || entry.to?.aadObjectId === wanted,
    );
  }

  activity.sort((a, b) => b.time.getTime() - a.time.getTime());

  // One read of Zaplie's own records: nothing per wallet can be skipped or
  // truncated any more. The coverage fields stay for the callers' shape.
  return {
    zaps: activity.slice(0, limit),
    partial: false,
    skippedUsers: 0,
    skippedWallets: 0,
    truncated: false,
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
// balance (Zaplie cannot read it), so only zaps sent out of Allowance wallets
// count.
//
// This is the same *measure* as the portal leaderboard
// (tabs/src/components/Leaderboard.tsx) — sats sent, ranked per user — but it is
// stricter about what counts: the portal sums every outgoing payment from any
// mapped wallet minus "Weekly Allowance cleared", while this reuses
// getRecentZaps(), which additionally requires the payment to leave an Allowance
// wallet and to carry Zaplie's zap metadata. The bot therefore excludes
// outgoing payments the portal would still count, such as a withdrawal to an
// external invoice. Expect small differences until the two converge.
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
