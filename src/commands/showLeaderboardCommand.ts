import { SSOCommand, SSOCommandMap } from './SSOCommandMap';
import {
  TeamsActivityHandler,
  TurnContext,
  SigninStateVerificationQuery,
  MemoryStorage,
  ConversationState,
  UserState,
  CardFactory,
  Middleware,
  MessageFactory,
} from 'botbuilder';
import { getWallets, getUser } from '../services/lnbitsService';
import { getRewardName } from '../services/fetchRewardsName';

const adminKey = process.env.LNBITS_ADMINKEY as string;


// New command for showing leaderboard
export class ShowLeaderboardCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    try {
      //await context.sendActivity('Showing leaderboard...');
      console.log('Showing leaderboard...');

        // Fetch the latest reward name
      const globalRewardName = await getRewardName();
      console.log('Fetched Reward Name:', globalRewardName);

      // Call the getWallets function
      const wallets = await getWallets(adminKey, 'Private');

      if (wallets) {
        const filteredWallets = wallets.filter(wallet =>
          wallet.name.toLowerCase().includes('private'),
        );
        console.log('Filtered Wallets:', filteredWallets);

        // Sort wallets by balance_msat in descending order
        const sortedWallets = filteredWallets.sort(
          (a, b) => b.balance_msat - a.balance_msat,
        );

        // Format the sorted wallets into an actionable card response
        const cardResponse = {
          type: 'AdaptiveCard',
          body: await Promise.all(
            filteredWallets.map(async wallet => {
              let user = await getUser(adminKey, wallet.user);
              return {
                type: 'TextBlock',
                text: `${user.displayName}\n: ${
                  wallet.balance_msat / 1000
                } ${globalRewardName}`,
                weight: 'Bolder',
                size: 'Medium',
              };
            }),
          ),
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'View Wallets',
              url: 'https://localhost:3000/wallets',
            },
          ],
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.2',
        };

        // Send the formatted card as an activity
        await context.sendActivity({
          attachments: [CardFactory.adaptiveCard(cardResponse)],
        });
      }
    } catch (error) {
      console.error('Error showing leaderboard:', error);
      await context.sendActivity(
        'Sorry, something went wrong while showing the leaderboard.',
      );
    }
  }
}
