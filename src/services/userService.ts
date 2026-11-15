// userService.ts

import { TeamsChannelAccount } from 'botbuilder';
import { ensurePerson } from './peopleDirectory';

export class UserService {
  private static instance: UserService;
  private constructor() {}

  // Private variable to hold the current user
  private currentUser: User;

  public static getInstance(): UserService {
    if (!UserService.instance) {
      UserService.instance = new UserService();
    }
    return UserService.instance;
  }

  // Setter function to update the current user
  public setCurrentUser(user: User) {
    this.currentUser = user;
  }

  // Getter function to access the current user
  public getCurrentUser(): User {
    return this.currentUser;
  }

  /**
   * Resolves the turn's sender in Zaplie's people directory, which adds them
   * on their first turn and, when the portal holds an LNbits API token,
   * creates their Allowance wallet under zaplie.service. Nothing is created in
   * LNbits for the person's own account and no balance is minted: the opening
   * allowance is paid from the Fund wallet by the allowance extension.
   *
   * The returned user's `allowanceWallet` is null until a wallet exists
   * (no token and no operator link yet); commands that spend check for it.
   */
  public async ensureUserSetup(
    teamsChannelAccount: TeamsChannelAccount,
  ): Promise<User> {
    const { user } = await ensurePerson({
      aadObjectId: teamsChannelAccount.aadObjectId,
      displayName: teamsChannelAccount.name,
      email: teamsChannelAccount.email,
    });
    this.setCurrentUser(user);
    return user;
  }
}
