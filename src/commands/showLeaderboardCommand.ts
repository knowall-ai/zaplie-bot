import { SSOCommand } from './SSOCommandMap';
import { TurnContext, CardFactory } from 'botbuilder';
import { getZapLeaderboard } from '../services/zapHistoryService';
import { positiveIntFromEnv } from '../services/envNumbers';

export const LEADERBOARD_UNAVAILABLE_MESSAGE =
  'Sorry, I could not load the leaderboard just now. Please try again in a moment.';

export const LEADERBOARD_WINDOW_DAYS_VAR = 'LEADERBOARD_WINDOW_DAYS';
export const LEADERBOARD_TOP_N_VAR = 'LEADERBOARD_TOP_N';
// Same default period as the portal leaderboard, so the two agree out of the
// box. The window has no "all time" value on purpose: an unbounded window over
// a team's whole history is the slowest read the bot can make, and the card
// would quietly turn into a lifetime ranking nobody asked for.
export const DEFAULT_LEADERBOARD_WINDOW_DAYS = 7;
export const DEFAULT_LEADERBOARD_TOP_N = 10;

const SECONDS_PER_DAY = 24 * 60 * 60;

export interface LeaderboardSettings {
  windowDays: number;
  topN: number;
}

/**
 * Reads the leaderboard settings at call time, so tests can vary them per case.
 * A deployed change takes effect on the next process start, because the env
 * files are loaded once at import. Invalid values throw — the command then
 * fails closed rather than ranking with a silently corrected number — and
 * `positiveIntFromEnv` names the offending variable in the message it throws,
 * which is what reaches the operator's log.
 */
export function readLeaderboardSettings(): LeaderboardSettings {
  return {
    windowDays: positiveIntFromEnv(
      LEADERBOARD_WINDOW_DAYS_VAR,
      DEFAULT_LEADERBOARD_WINDOW_DAYS,
    ),
    topN: positiveIntFromEnv(LEADERBOARD_TOP_N_VAR, DEFAULT_LEADERBOARD_TOP_N),
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

// A team-wide read can miss a user or a wallet (a rate-limited LNbits response,
// say). The totals are then a floor, not a total, and someone can be missing
// from the card altogether — so the card says so rather than presenting an
// incomplete ranking as the ranking.
export const LEADERBOARD_PARTIAL_MESSAGE =
  'Some wallets could not be read just now, so this ranking may be incomplete.';

export interface LeaderboardEntry {
  displayName: string;
  amount: number;
}

export interface LeaderboardCardOptions {
  title: string;
  emptyMessage: string;
  portalUrl?: string;
  partial?: boolean;
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
  const { title, emptyMessage, portalUrl, partial } = options;
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
                text: `${entry.amount.toLocaleString()} ${rewardName}`,
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
              text: LEADERBOARD_PARTIAL_MESSAGE,
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
              title: 'View Wallets',
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
        title: leaderboardTitle(windowDays, globalRewardName),
        emptyMessage: leaderboardEmptyMessage(windowDays),
        portalUrl: process.env.PORTAL_URL,
        partial: leaderboard.partial,
      });

      await context.sendActivity({
        attachments: [CardFactory.adaptiveCard(cardResponse)],
      });
    } catch (error) {
      console.error('Error showing leaderboard:', error);
      await context.sendActivity(LEADERBOARD_UNAVAILABLE_MESSAGE);
    }
  }
}
