// userService.ts

import { TeamsChannelAccount } from 'botbuilder';
import {
  getUsers,
  createUser,
  createWallet,
  getUserWallets,
  topUpWallet,
  getWalletById,
} from './lnbitsService';
import { boundedPositiveIntFromEnv } from './envNumbers';

const adminKey = process.env.LNBITS_ADMINKEY as string;

export const INITIAL_ALLOWANCE_ENV = 'LNBITS_INITIAL_ALLOWANCE';
// One week's Allowance. The opening grant lets a new joiner zap before their
// first weekly top-up, so more than a week is never a correct value, and the
// admin top-up behind it creates unbacked sats: a stray digit must stop the
// bot, not fund every new wallet.
export const MAX_INITIAL_ALLOWANCE = 25000;

// The opening grant for a new Allowance wallet. Unset or blank means no grant
// (production: the LNbits allowance extension funds wallets, and an admin
// top-up creates sats with no backing). Anything else must be a positive
// whole number of sats from 1 to MAX_INITIAL_ALLOWANCE: parseInt read '1e3'
// as 1 and '25,000' as 25, and a typo here pays the wrong amount into every
// new user's wallet. Resolved once, in the UserService constructor, so a
// malformed value stops the bot at startup (src/index.ts constructs the
// singleton before it listens), like ZAP_MAX_RECIPIENTS. Above
// MAX_INITIAL_ALLOWANCE is refused the same way.
export const resolveInitialAllowance = (): number | null =>
  boundedPositiveIntFromEnv(INITIAL_ALLOWANCE_ENV, null, MAX_INITIAL_ALLOWANCE);

async function applyInitialAllowance(
  walletId: string,
  amount: number | null,
): Promise<void> {
  if (amount === null) {
    return;
  }
  await topUpWallet(walletId, amount);
}

export class UserService {
  private static instance: UserService;
  private users: Map<string, User> = new Map(); // Simple in-memory cache
  private readonly initialAllowance = resolveInitialAllowance();
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

  public async ensureUserSetup(
    teamsChannelAccount: TeamsChannelAccount,
  ): Promise<User> {
    const aadObjectId = teamsChannelAccount.aadObjectId;

    let user: User;
    const lnbitsUsers = await getUsers(adminKey, {
      aadObjectId: aadObjectId, // userProfile.aadObjectId,
    });
    if (lnbitsUsers.length > 1) {
      throw new Error('More than one user found with the same aadObjectId');
    }

    if (!lnbitsUsers || lnbitsUsers.length < 1) {
      user = await createUser(
        adminKey,
        teamsChannelAccount.name,
        'Private',
        teamsChannelAccount.email,
        '',
        {
          aadObjectId: aadObjectId,
          userType: 'teammate',
          profileImg: `https://hiberniaevros.sharepoint.com/_layouts/15/userphoto.aspx?AccountName='${teamsChannelAccount.userPrincipalName}`,
        },
      );

      const allowanceWallet = await createWallet(
        adminKey,
        user.id,
        'Allowance',
      );
      await applyInitialAllowance(allowanceWallet.id, this.initialAllowance);
      user = { ...user, allowanceWallet };
    } else {
      user = lnbitsUsers[0];
    }

    let allowanceWallet = user.allowanceWallet
      ? await getWalletById(user.id, user.allowanceWallet.id)
      : null;
    if (allowanceWallet?.deleted) {
      throw new Error(
        'Mmm ... it looks like your allowance wallet has been deleted?!',
      );
    }
    if (!allowanceWallet) {
      const userWallets = await getUserWallets(adminKey, user.id);
      // Only fund a wallet we just created: existing users pass through here
      // every turn, and re-funding on balance would let anyone who spends to
      // zero get topped back up on their next message.
      allowanceWallet = userWallets.find(w => w.name === 'Allowance') ?? null;
      if (!allowanceWallet) {
        allowanceWallet = await createWallet(adminKey, user.id, 'Allowance');
        await applyInitialAllowance(allowanceWallet.id, this.initialAllowance);
      }
      user = { ...user, allowanceWallet };
    }

    let privateWallet = user.privateWallet
      ? await getWalletById(user.id, user.privateWallet.id)
      : null;
    if (privateWallet?.deleted) {
      throw new Error(
        'Mmm ... it looks like your private wallet has been deleted?!',
      );
    }
    if (!privateWallet) {
      const userWallets = await getUserWallets(adminKey, user.id);
      privateWallet =
        userWallets.find(w => w.name === 'Private') ??
        (await createWallet(adminKey, user.id, 'Private'));
      user = { ...user, privateWallet };
    }

    this.setCurrentUser(user);
    return user;
  }
}
