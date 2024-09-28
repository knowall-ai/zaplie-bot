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
import {
  payInvoice,
  getWalletIdByUserId,
  createInvoice,
  getUserWallets,
} from '../services/lnbitsService';

const adminKey = process.env.LNBITS_ADMINKEY as string;

export class ShowMyBalanceCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    try {
      //await context.sendActivity('Showing your balance...');
      console.log('Showing your balance...');

      // Retrieve the user object from the turn state
      const user = context.turnState.get('user') as User;

      if (!user) {
        await context.sendActivity('User not found.');
        return;
      }

      console.log('User:', user);

      // Get the user's wallets
      const usersWallets = await getUserWallets(adminKey, user.id);

      if (!usersWallets || usersWallets.length === 0) {
        await context.sendActivity('No wallets found for the user.');
        return;
      }

      console.log('User Wallets:', usersWallets);

      // Loop through all wallets and send their balances
      for (const wallet of usersWallets) {
        const balanceMsat = wallet.balance_msat;
        if (balanceMsat === undefined) {
          await context.sendActivity(
            `Balance information not available for wallet ${wallet.id}.`,
          );
          continue;
        }

        const balanceSat = balanceMsat / 1000; // Convert from msat to sat
        await context.sendActivity(
          `Your ${wallet.name} wallet has a balance of ${balanceSat} satoshis.`,
        );
      }
    } catch (error) {
      console.error('Error in ShowMyBalanceCommand:', error);
      await context.sendActivity(
        'Sorry, something went wrong while showing your balance.',
      );
    }
  }
}
