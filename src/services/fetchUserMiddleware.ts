import { Middleware, TurnContext } from 'botbuilder';
import { UserService } from './userService';

export class FetchUserMiddleware {
  private userService: UserService;

  constructor(userService: UserService) {
    this.userService = userService;
  }

  async onTurn(context: TurnContext, next: () => Promise<void>): Promise<void> {
    // Check if user is already stored in the turn state (for the current turn)
    if (!context.turnState.get('user')) {
      const user = await this.userService.getUser(context);
      context.turnState.set('user', user); // Store user in turn state for this turn
    }

    // Continue with the next middleware or bot logic
    await next();
  }
}
