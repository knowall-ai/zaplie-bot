// userService.ts

/// <reference path="../../src/types/global.d.ts" />
import {
  ConsoleTranscriptLogger,
  TeamsChannelAccount,
  TurnContext,
  TeamsInfo,
} from 'botbuilder';
import { TeamsActivityHandler } from 'botbuilder';
import {
  getUsers,
  createUser,
  createWallet,
  updateUser,
  getUser,
  getUserWallets,
  topUpWallet,
  getWalletById,
  getWalletName,
  getWallets,
} from './lnbitsService';
import { syncBuiltinESMExports } from 'module';

const adminKey = process.env.LNBITS_ADMINKEY as string;

interface CancellationToken {
  isCancellationRequested: boolean;
}

function sanitizeString(str: string): string {
  return str.replace(/[^a-zA-Z0-9]/g, '');
}

export class UserService {
  private static instance: UserService;
  private users: Map<string, User> = new Map(); // Simple in-memory cache
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
    console.log('ensureUserSetup starting ...');

    let user: User | null = null;
    let lnbitsUsers = await getUsers(adminKey, {
      aadObjectId: teamsChannelAccount.aadObjectId, // userProfile.aadObjectId,
    });
    if (lnbitsUsers.length > 1) {
      throw new Error('More than one user found with the same aadObjectId');
    }

    if (!lnbitsUsers || lnbitsUsers.length < 1) {
      // Create LNbits user (they don't exist yet)
      user = await createUser(
        adminKey,
        teamsChannelAccount.name,
        'Private',
        teamsChannelAccount.email,
        '', // The password is a legacy field and ignored anyway.
        {
          aadObjectId: teamsChannelAccount.aadObjectId,
          userType: 'teammate',
          profileImg: `https://hiberniaevros.sharepoint.com/_layouts/15/userphoto.aspx?AccountName='${teamsChannelAccount.userPrincipalName}`, // TODO: Get the user's profile image from Teams
          //profileImg: teamsChannelAccount.properties
        }, // We'll check and update this when when they have both wallets anyway.
      );

      // Create their allowance wallet
      const allowanceWallet = await createWallet(
        adminKey,
        user.id,
        'Allowance',
      );
      // TODO: Put this into a function (re-use below)
      const initialAllowanceStr = process.env.LNBITS_INITIAL_ALLOWANCE;
      if (initialAllowanceStr) {
        const initialAllowance = parseInt(initialAllowanceStr); // Parse as a floating-point number
        if (!isNaN(initialAllowance)) {
          await topUpWallet(allowanceWallet.id, initialAllowance);
        } else {
          console.error(
            'Invalid initial allowance value:',
            initialAllowanceStr,
          );
        }
      }
      user = await updateUser(adminKey, user.id, {
        allowanceWalletId: allowanceWallet.id,
      }); // Update the user with the allowance wallet id
    }

    // OK, so the user exists in LNbits
    // Now let's ensure they have both wallets

    user = lnbitsUsers[0];

    let allowanceWallet = null;

    if (user.allowanceWallet) {
      allowanceWallet = await getWalletById(user.id, user.allowanceWallet.id);
      if (allowanceWallet.deleted) {
        throw new Error(
          'Mmm ... it looks like your allowance wallet has been deleted?!',
        );
      }
    }
    if (!allowanceWallet) {
      // No matching allowance wallet found, create their allowance wallet
      // But first, we should check if they have a wallet by that name already
      let userWallets = await getUserWallets(adminKey, user.id);
      let allowanceWallet = userWallets.find(w => w.name === 'Allowance');
      if (allowanceWallet.balance_msat < 1) {
        // If the orphaned wallet we found is empty, let's top them up so they can zap!
        // TODO: Separate this out into a function
        const initialAllowanceStr = process.env.LNBITS_INITIAL_ALLOWANCE;
        if (initialAllowanceStr) {
          const initialAllowance = parseInt(initialAllowanceStr); // Parse as a floating-point number
          if (!isNaN(initialAllowance)) {
            await topUpWallet(allowanceWallet.id, initialAllowance);
          } else {
            console.error(
              'Invalid initial allowance value:',
              initialAllowanceStr,
            );
          }
        }
      }
      if (!allowanceWallet) {
        allowanceWallet = await createWallet(adminKey, user.id, 'Allowance');
        // TODO: Put this into a function (re-use below)
        const initialAllowanceStr = process.env.LNBITS_INITIAL_ALLOWANCE;
        if (initialAllowanceStr) {
          const initialAllowance = parseInt(initialAllowanceStr); // Parse as a floating-point number
          if (!isNaN(initialAllowance)) {
            await topUpWallet(allowanceWallet.id, initialAllowance);
          } else {
            console.error(
              'Invalid initial allowance value:',
              initialAllowanceStr,
            );
          }
        }
      }
      user = await updateUser(adminKey, user.id, {
        allowanceWalletId: allowanceWallet.id,
      }); // Update the user with the allowance wallet id
    }

    let privateWallet = null;

    if (user.privateWallet) {
      privateWallet = await getWalletById(user.id, user.privateWallet.id);
      if (privateWallet.deleted) {
        throw new Error(
          'Mmm ... it looks like your private wallet has been deleted?!',
        );
      }
    }
    if (!privateWallet) {
      // No matching private wallet found, create their private wallet
      // But first, we should check if they have a wallet by that name already
      let userWallets = await getUserWallets(adminKey, user.id);
      let privateWallet = userWallets.find(w => w.name === 'Private');
      if (!privateWallet) {
        privateWallet = await createWallet(adminKey, user.id, 'Private');
      }
      user = await updateUser(adminKey, user.id, {
        privateWalletId: privateWallet.id,
      }); // Update the user with the private wallet id
    }

    // OK, now let's set the current user
    this.setCurrentUser(user);
    console.log('ensureUserSetup completed.');
    return user;
  }
}
