import { SSOCommand } from './SSOCommandMap';
import { TurnContext } from 'botbuilder';

export class WithdrawFundsCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    try {
      await context.sendActivity('Ah! Steady on cowboy ... coming soon!');
    } catch (error) {
      console.error('Error in WithdrawZapsCommand:', error);
    }
  }
}
