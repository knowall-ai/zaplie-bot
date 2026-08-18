import { SSOCommand } from './SSOCommandMap';
import { TurnContext, CardFactory } from 'botbuilder';
import { getWallets, getUsers } from '../services/lnbitsService';

const adminKey = process.env.LNBITS_ADMINKEY as string;

// Names what the numbers actually are. LNbits exposes a wallet balance, not a
// received-zaps total, so a title promising "zaps received" would misreport a
// user who has spent or withdrawn from their Private wallet.
export const LEADERBOARD_TITLE = 'Current leaders (Private wallet balance):';
export const LEADERBOARD_EMPTY_MESSAGE =
  'No zaps received yet — be the first to send one!';
export const LEADERBOARD_UNAVAILABLE_MESSAGE =
  'Sorry, I could not load the leaderboard just now. Please try again in a moment.';
export const LEADERBOARD_LIMIT = 10;

export interface LeaderboardEntry {
  displayName: string;
  amount: number;
}

// Builds the leaderboard card: a title, then one two-column row per leader
// (rank + name on the left, bold amount on the right), capped at the top
// LEADERBOARD_LIMIT entries. Entries must already be sorted. With no entries
// the card says so instead of showing a title over nothing.
export function buildLeaderboardCard(
  entries: LeaderboardEntry[],
  rewardName: string,
  portalUrl?: string,
) {
  const leaders = entries.slice(0, LEADERBOARD_LIMIT);
  return {
    type: 'AdaptiveCard',
    body: [
      {
        type: 'TextBlock',
        text: LEADERBOARD_TITLE,
        weight: 'Bolder',
        size: 'Medium',
        wrap: true,
      },
      ...(leaders.length === 0
        ? [
            {
              type: 'TextBlock',
              text: LEADERBOARD_EMPTY_MESSAGE,
              wrap: true,
            },
          ]
        : []),
      ...leaders.map((entry, index) => ({
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

// New command for showing leaderboard
export class ShowLeaderboardCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    try {
      console.log('Showing leaderboard...');

      const globalRewardName = process.env.LNBITS_POINTS_LABEL as string;

      const wallets = await getWallets(adminKey, 'Private');
      const users = await getUsers(adminKey, null);
      // Silence is the wrong answer to a failed lookup: the user typed a
      // command and must be told it did not work.
      if (!wallets || !users) {
        console.error(
          'Leaderboard unavailable: LNbits returned no wallet or user list.',
        );
        await context.sendActivity(LEADERBOARD_UNAVAILABLE_MESSAGE);
        return;
      }

      // One getUsers call for every display name instead of a getUser
      // round-trip per wallet.
      const nameByUserId = new Map(
        users.map(individual => [individual.id, individual.displayName]),
      );

      const entries: LeaderboardEntry[] = [];
      for (const candidate of wallets.filter(candidateWallet =>
        candidateWallet.name.toLowerCase().includes('private'),
      )) {
        const displayName = nameByUserId.get(candidate.user);
        if (!displayName) {
          // Ranking a wallet we cannot attribute would publish a balance under
          // a placeholder name. Leave it out and flag it for an operator.
          console.warn(
            `Leaderboard: skipping wallet ${candidate.id}; its owner is missing from the LNbits user list.`,
          );
          continue;
        }
        entries.push({
          displayName,
          amount: candidate.balance_msat / 1000,
        });
      }

      // NOTE: the ranking is by Private wallet *balance*, not by a true
      // "zaps received" total — LNbits only exposes the balance, and a
      // withdrawal would lower a user's rank. Constraint of the LNbits
      // data model, which is why the title names the balance.
      // Equal balances are ordered by name so the card is stable between runs.
      entries.sort(
        (first, second) =>
          second.amount - first.amount ||
          first.displayName.localeCompare(second.displayName),
      );

      // The portal shares the PORTAL_URL name with tabs/backend (see
      // env/.env.dev.example). Without it there is no live portal to link
      // to, so the button is omitted rather than pointing at a dead URL.
      const cardResponse = buildLeaderboardCard(
        entries,
        globalRewardName,
        process.env.PORTAL_URL,
      );

      // Send the formatted card as an activity
      await context.sendActivity({
        attachments: [CardFactory.adaptiveCard(cardResponse)],
      });
    } catch (error) {
      console.error('Error showing leaderboard:', error);
      await context.sendActivity(LEADERBOARD_UNAVAILABLE_MESSAGE);
    }
  }
}
