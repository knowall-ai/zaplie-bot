import { SSOCommand } from './SSOCommandMap';
import { TurnContext } from 'botbuilder';
import { getBalances } from '../services/peopleDirectory';
import { t } from '../i18n';

export class ShowMyBalanceCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    // The raw tag: it picks the language and groups the balance for the
    // client's region.
    const locale = context.activity?.locale;
    try {
      console.log('Showing your balance...');

      const globalRewardName = process.env.LNBITS_POINTS_LABEL as string;

      // Retrieve the user object from the turn state
      const user = context.turnState.get('user') as User;

      if (!user) {
        await context.sendActivity(t(locale, 'balanceUserNotFound'));
        return;
      }

      console.log('Showing balance for user', user.id);

      // The Allowance wallet is Zaplie's; the Private wallet is the person's
      // own and has a balance here only when they registered its invoice key.
      const balances = await getBalances(user.id);

      if (balances.allowanceSats === null) {
        await context.sendActivity(
          t(
            locale,
            user.allowanceWallet ? 'balanceUnavailable' : 'allowanceNotReady',
            {
              walletId: user.allowanceWallet?.id ?? '',
            },
          ),
        );
      } else {
        await context.sendActivity(
          t(locale, 'balanceLine', {
            walletName: 'Allowance',
            balance: balances.allowanceSats,
            rewardName: globalRewardName,
          }),
        );
      }

      await context.sendActivity(
        balances.privateSats === null
          ? t(locale, 'balancePrivateNotLinked')
          : t(locale, 'balanceLine', {
              walletName: 'Private',
              balance: balances.privateSats,
              rewardName: globalRewardName,
            }),
      );
    } catch (error) {
      console.error('Error in ShowMyBalanceCommand:', error);
      await context.sendActivity(t(locale, 'balanceError'));
    }
  }
}
