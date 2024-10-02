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

export class WithdrawFundsCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    try {
      await context.sendActivity('Ah! Steady on cowboy ... coming soon!');
    } catch (error) {
      console.error('Error in WithdrawZapsCommand:', error);
    }
  }
}
