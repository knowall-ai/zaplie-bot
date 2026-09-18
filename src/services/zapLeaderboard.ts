// zapLeaderboard.ts
//
// Ranks people by the sats they have zapped OUT of their Allowance wallet.
// That is the product rule for every leaderboard (see docs/SOLUTION_DESIGN.adoc,
// "Two wallets per user"): the Private wallet is private, so its balance is
// never surfaced or ranked, and only zaps that left an Allowance wallet and
// landed in a Private wallet count. The zap ledger itself comes from
// zapHistoryService, which already applies those rules; this module only
// aggregates and reads its settings.
//
// Pure functions, no I/O, so the command, the assistant tool and the tests
// can share one aggregator.

import { ZapActivity } from './zapHistoryService';

export interface ZapSenderTotal {
  displayName: string;
  zapsSent: number;
  satsSent: number;
}

export interface LeaderboardSettings {
  windowDays: number;
  topN: number;
}

export const LEADERBOARD_WINDOW_DAYS_VAR = 'LEADERBOARD_WINDOW_DAYS';
export const LEADERBOARD_TOP_N_VAR = 'LEADERBOARD_TOP_N';
// Same default period as the portal leaderboard, so the two agree out of
// the box.
export const DEFAULT_LEADERBOARD_WINDOW_DAYS = 7;
export const DEFAULT_LEADERBOARD_TOP_N = 10;

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Sums sats and zap counts per sender and returns the top senders, highest
 * sats first, ties broken by display name so the card is stable between runs.
 * Zaps whose sender could not be resolved are skipped rather than shown under
 * a placeholder name, and a zap from a person to themselves is not
 * recognition, so it is skipped too.
 */
export function rankZapSenders(
  zaps: ZapActivity[],
  topN: number,
): ZapSenderTotal[] {
  const totals = new Map<string, ZapSenderTotal>();

  for (const zap of zaps) {
    if (!zap.from || zap.to?.id === zap.from.id) {
      continue;
    }
    const current = totals.get(zap.from.id) ?? {
      displayName: zap.from.displayName,
      zapsSent: 0,
      satsSent: 0,
    };
    current.zapsSent += 1;
    current.satsSent += zap.amountSats;
    totals.set(zap.from.id, current);
  }

  return [...totals.values()]
    .sort(
      (first, second) =>
        second.satsSent - first.satsSent ||
        first.displayName.localeCompare(second.displayName),
    )
    .slice(0, topN);
}

// Plain decimal digits only: "1e2", "0x10", "+5" and "10.0" are all things
// Number() would accept and an operator would not mean.
const WHOLE_NUMBER = /^\d{1,9}$/;

const readWholeNumber = (
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number => {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const trimmed = raw.trim();
  const value = WHOLE_NUMBER.test(trimmed) ? Number(trimmed) : NaN;
  if (Number.isNaN(value) || value < minimum) {
    throw new Error(
      `${name} must be a whole number of at least ${minimum}, got "${raw}"`,
    );
  }
  return value;
};

/**
 * Reads the leaderboard settings at call time, so tests can vary them per
 * case. A deployed change takes effect on the next process start, because
 * the env files are loaded once at import. Invalid values throw so the
 * command fails
 * closed instead of ranking with a silently corrected number. The window has
 * no "all time" option on purpose: LNbits returns at most 100 payments per
 * wallet, so an unbounded window would silently undercount.
 */
export function readLeaderboardSettings(
  env: NodeJS.ProcessEnv = process.env,
): LeaderboardSettings {
  return {
    windowDays: readWholeNumber(
      LEADERBOARD_WINDOW_DAYS_VAR,
      env[LEADERBOARD_WINDOW_DAYS_VAR],
      DEFAULT_LEADERBOARD_WINDOW_DAYS,
      1,
    ),
    topN: readWholeNumber(
      LEADERBOARD_TOP_N_VAR,
      env[LEADERBOARD_TOP_N_VAR],
      DEFAULT_LEADERBOARD_TOP_N,
      1,
    ),
  };
}

/** Unix seconds where the window starts. */
export function windowStartSeconds(
  windowDays: number,
  nowMs: number = Date.now(),
): number {
  return Math.floor(nowMs / 1000) - windowDays * SECONDS_PER_DAY;
}

export function leaderboardWindowLabel(windowDays: number): string {
  return `last ${windowDays} days`;
}

export function leaderboardTitle(
  windowDays: number,
  rewardName: string,
): string {
  return `Top zappers (${rewardName} sent, ${leaderboardWindowLabel(windowDays)}):`;
}

export function leaderboardEmptyMessage(windowDays: number): string {
  return `No zaps sent in the ${leaderboardWindowLabel(windowDays)} yet. Send a zap to get things started!`;
}
