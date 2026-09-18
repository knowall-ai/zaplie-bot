import { SSOCommand } from './SSOCommandMap';
import { TurnContext, CardFactory } from 'botbuilder';
import { getRecentZaps } from '../services/zapHistoryService';
import {
  leaderboardEmptyMessage,
  leaderboardTitle,
  rankZapSenders,
  readLeaderboardSettings,
  windowStartSeconds,
} from '../services/zapLeaderboard';

export const LEADERBOARD_UNAVAILABLE_MESSAGE =
  'Sorry, I could not load the leaderboard just now. Please try again in a moment.';

export interface LeaderboardEntry {
  displayName: string;
  amount: number;
}

export interface LeaderboardCardOptions {
  title: string;
  emptyMessage: string;
  portalUrl?: string;
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
  const { title, emptyMessage, portalUrl } = options;
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
export class ShowLeaderboardCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    try {
      console.log('Showing leaderboard...');

      const globalRewardName = process.env.LNBITS_POINTS_LABEL as string;

      // Read inside the try so a bad setting reaches the user as
      // "unavailable" and the operator as a log line naming the variable.
      const { windowDays, topN } = readLeaderboardSettings();

      // getRecentZaps already keeps only outgoing Allowance payments that
      // landed in a Private wallet and drops the weekly sweep, so the ledger
      // it returns is exactly what may be ranked. Its default limit is sized
      // for a feed, not a total, hence the explicit ceiling.
      const zaps = await getRecentZaps({
        sinceTimestamp: windowStartSeconds(windowDays),
        limit: Number.MAX_SAFE_INTEGER,
      });

      const entries: LeaderboardEntry[] = rankZapSenders(zaps, topN).map(
        sender => ({
          displayName: sender.displayName,
          amount: sender.satsSent,
        }),
      );

      // The portal shares the PORTAL_URL name with tabs/backend (see
      // env/.env.dev.example). Without it there is no live portal to link
      // to, so the button is omitted rather than pointing at a dead URL.
      const cardResponse = buildLeaderboardCard(entries, globalRewardName, {
        title: leaderboardTitle(windowDays, globalRewardName),
        emptyMessage: leaderboardEmptyMessage(windowDays),
        portalUrl: process.env.PORTAL_URL,
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
