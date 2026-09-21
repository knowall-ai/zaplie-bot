import { SSOCommand } from './SSOCommandMap';
import { TurnContext } from 'botbuilder';
import { getUserWallets } from '../services/lnbitsService';
import { resolveLocale, t } from '../i18n';

const adminKey = process.env.LNBITS_ADMINKEY as string;

export class ShowMyBalanceCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    const locale = resolveLocale(context.activity?.locale);
    try {
      //await context.sendActivity('Showing your balance...');
      console.log('Showing your balance...');

      const globalRewardName = process.env.LNBITS_POINTS_LABEL as string;

      // Retrieve the user object from the turn state
      const user = context.turnState.get('user') as User;

      if (!user) {
        await context.sendActivity(t(locale, 'balanceUserNotFound'));
        return;
      }

      // Wallet objects carry keys, so only the id is logged.
      console.log('Showing balance for user', user.id);

      // Get the user's wallets
      const usersWallets = await getUserWallets(adminKey, user.id);

      if (!usersWallets || usersWallets.length === 0) {
        await context.sendActivity(t(locale, 'balanceNoWallets'));
        return;
      }

      // Loop through all wallets and send their balances
      for (const wallet of usersWallets) {
        const balanceMsat = wallet.balance_msat;
        if (balanceMsat === undefined) {
          await context.sendActivity(
            t(locale, 'balanceUnavailable', { walletId: wallet.id }),
          );
          continue;
        }

        const balanceSat = balanceMsat / 1000; // Convert from msat to sat
        await context.sendActivity(
          t(locale, 'balanceLine', {
            walletName: wallet.name,
            balance: balanceSat,
            rewardName: globalRewardName,
          }),
        );
      }
    } catch (error) {
      console.error('Error in ShowMyBalanceCommand:', error);
      await context.sendActivity(t(locale, 'balanceError'));
    }
  }
}
