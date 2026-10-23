import { SSOCommand } from './SSOCommandMap';
import { TurnContext, CardFactory } from 'botbuilder';
import { getZapLeaderboard } from '../services/zapHistoryService';
import { positiveIntFromEnv } from '../services/envNumbers';
import { LocaleTag, en, formatNumber, t } from '../i18n';

// The copy lives in src/i18n, translated per client language; these constants
// are the English renderings, kept for callers and tests that compare against
// them.
export const LEADERBOARD_UNAVAILABLE_MESSAGE = en.leaderboardUnavailable;

export const LEADERBOARD_WINDOW_DAYS_VAR = 'LEADERBOARD_WINDOW_DAYS';
export const LEADERBOARD_TOP_N_VAR = 'LEADERBOARD_TOP_N';
// Same default period as the portal leaderboard, so the two agree out of the
// box. The window has no "all time" value on purpose: an unbounded window over
// a team's whole history is the slowest read the bot can make, and the card
// would quietly turn into a lifetime ranking nobody asked for.
export const DEFAULT_LEADERBOARD_WINDOW_DAYS = 7;
export const DEFAULT_LEADERBOARD_TOP_N = 10;

// Ceilings. The window is shared with the assistant's get_leaderboard tool,
// which rejects a larger `days` too, so the card and the assistant accept the
// same range. A year keeps the cut-off a real timestamp (a huge window used to
// go negative, count every zap ever made and still say "last N days"), and 100
// rows keeps the Teams card well inside its size limit.
export const MAX_LEADERBOARD_WINDOW_DAYS = 365;
export const MAX_LEADERBOARD_TOP_N = 100;

const SECONDS_PER_DAY = 24 * 60 * 60;

export interface LeaderboardSettings {
  windowDays: number;
  topN: number;
}

// Above the ceiling is rejected, not clamped: a clamped value would rank a
// window or a row count nobody configured while the operator believes theirs
// was applied. The message names the variable, like a malformed value's does.
function boundedPositiveIntFromEnv(
  name: string,
  fallback: number,
  max: number,
): number {
  const value = positiveIntFromEnv(name, fallback);
  if (value > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}`);
  }
  return value;
}

/**
 * Reads the leaderboard window (in days) at call time. Shared with the
 * assistant's get_leaderboard tool, which uses it when the model omits `days`,
 * so the card and the assistant measure the same window by default.
 */
export function readLeaderboardWindowDays(): number {
  return boundedPositiveIntFromEnv(
    LEADERBOARD_WINDOW_DAYS_VAR,
    DEFAULT_LEADERBOARD_WINDOW_DAYS,
    MAX_LEADERBOARD_WINDOW_DAYS,
  );
}

/**
 * Reads the leaderboard settings at call time, so tests can vary them per case.
 * A deployed change takes effect on the next process start, because the env
 * files are loaded once at import. Invalid or out-of-range values throw — the
 * command then fails closed rather than ranking with a silently corrected
 * number — and the thrown message names the offending variable, which is what
 * reaches the operator's log.
 */
export function readLeaderboardSettings(): LeaderboardSettings {
  return {
    windowDays: readLeaderboardWindowDays(),
    topN: boundedPositiveIntFromEnv(
      LEADERBOARD_TOP_N_VAR,
      DEFAULT_LEADERBOARD_TOP_N,
      MAX_LEADERBOARD_TOP_N,
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

// The window, title and empty copy follow the client language (`locale` is
// the raw activity.locale; English when omitted). One day is singular in both
// languages, never "last 1 days". The empty message has its own one-day and
// N-day keys because Spanish needs the article to agree ("en el último día",
// "en los últimos 7 días").
export function leaderboardWindowLabel(
  windowDays: number,
  locale: LocaleTag = 'en',
): string {
  return windowDays === 1
    ? t(locale, 'leaderboardWindowOneDay')
    : t(locale, 'leaderboardWindowDays', { days: windowDays });
}

export function leaderboardTitle(
  windowDays: number,
  rewardName: string,
  locale: LocaleTag = 'en',
): string {
  return t(locale, 'leaderboardTitle', {
    rewardName,
    window: leaderboardWindowLabel(windowDays, locale),
  });
}

export function leaderboardEmptyMessage(
  windowDays: number,
  locale: LocaleTag = 'en',
): string {
  return windowDays === 1
    ? t(locale, 'leaderboardEmptyOneDay')
    : t(locale, 'leaderboardEmptyDays', { days: windowDays });
}

// A team-wide read can miss a user or a wallet (a rate-limited LNbits response,
// say). The totals are then a floor, not a total, and someone can be missing
// from the card altogether — so the card says so rather than presenting an
// incomplete ranking as the ranking.
export const LEADERBOARD_PARTIAL_MESSAGE = en.leaderboardPartial;

export interface LeaderboardEntry {
  displayName: string;
  amount: number;
}

export interface LeaderboardCardOptions {
  title: string;
  emptyMessage: string;
  portalUrl?: string;
  partial?: boolean;
  // The raw activity.locale: picks the language of the card's own copy and
  // groups the amounts for the client's region. English when omitted.
  locale?: LocaleTag;
}

// Builds the leaderboard card: a title, then one two-column row per leader
// (rank + name on the left, bold amount on the right). Entries must already
// be sorted and capped by the caller. With no entries the card says so
// instead of showing a title over nothing.
export function buildLeaderboardCard(
  entries: LeaderboardEntry[],
  rewardName: string,
  options: LeaderboardCardOptions,
) {
  const { title, emptyMessage, portalUrl, partial, locale = 'en' } = options;
  return {
    type: 'AdaptiveCard',
    body: [
      {
        type: 'TextBlock',
        text: title,
        weight: 'Bolder',
        size: 'Medium',
        wrap: true,
      },
      ...(entries.length === 0
        ? [
            {
              type: 'TextBlock',
              text: emptyMessage,
              wrap: true,
            },
          ]
        : []),
      ...entries.map((entry, index) => ({
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            width: 'stretch',
            items: [
              {
                type: 'TextBlock',
                text: `#${index + 1} ${entry.displayName}`,
                wrap: true,
              },
            ],
          },
          {
            type: 'Column',
            width: 'auto',
            items: [
              {
                type: 'TextBlock',
                text: `${formatNumber(entry.amount, locale)} ${rewardName}`,
                weight: 'Bolder',
              },
            ],
          },
        ],
      })),
      ...(partial
        ? [
            {
              type: 'TextBlock',
              text: t(locale, 'leaderboardPartial'),
              wrap: true,
              isSubtle: true,
              spacing: 'Medium',
            },
          ]
        : []),
    ],
    ...(portalUrl
      ? {
          actions: [
            {
              type: 'Action.OpenUrl',
              title: t(locale, 'leaderboardViewWallets'),
              url: `${portalUrl.replace(/\/+$/, '')}/wallet`,
            },
          ],
        }
      : {}),
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.2',
  };
}

// Ranks people by the sats they zapped out of their Allowance wallet inside
// the configured window. The Private wallet is never read: its balance is
// private, and a leaderboard on it would rank what people received (or kept)
// rather than what they gave.
//
// The ranking itself lives in zapHistoryService.getZapLeaderboard, shared with
// the assistant's get_leaderboard tool, so the chat card and the assistant
// cannot disagree about who is ahead for the same window. This command adds
// only what is its own: the configured window and row count, and the copy.
export class ShowLeaderboardCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    // The raw tag: it picks the language and groups the amounts for the
    // client's region.
    const locale = context.activity?.locale;
    try {
      console.log('Showing leaderboard...');

      const globalRewardName = process.env.LNBITS_POINTS_LABEL as string;

      // Read inside the try so a bad setting reaches the user as
      // "unavailable" and the operator as a log line naming the variable.
      const { windowDays, topN } = readLeaderboardSettings();

      const leaderboard = await getZapLeaderboard({
        sinceTimestamp: windowStartSeconds(windowDays),
      });

      const entries: LeaderboardEntry[] = leaderboard.entries
        .slice(0, topN)
        .map(entry => ({
          displayName: entry.user.displayName,
          amount: entry.zappedSats,
        }));

      // The portal shares the PORTAL_URL name with tabs/backend (see
      // env/.env.dev.example). Without it there is no live portal to link
      // to, so the button is omitted rather than pointing at a dead URL.
      const cardResponse = buildLeaderboardCard(entries, globalRewardName, {
        title: leaderboardTitle(windowDays, globalRewardName, locale),
        emptyMessage: leaderboardEmptyMessage(windowDays, locale),
        portalUrl: process.env.PORTAL_URL,
        partial: leaderboard.partial,
        locale,
      });

      await context.sendActivity({
        attachments: [CardFactory.adaptiveCard(cardResponse)],
      });
    } catch (error) {
      console.error('Error showing leaderboard:', error);
      await context.sendActivity(t(locale, 'leaderboardUnavailable'));
    }
  }
}
