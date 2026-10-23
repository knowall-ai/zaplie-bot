import { SSOCommand } from './SSOCommandMap';
import { TurnContext } from 'botbuilder';
import { t } from '../i18n';

export class WithdrawFundsCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    try {
      await context.sendActivity(
        t(context.activity?.locale, 'withdrawComingSoon'),
      );
    } catch (error) {
      console.error('Error in WithdrawZapsCommand:', error);
    }
  }
}
