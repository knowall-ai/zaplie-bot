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

async function applyInitialAllowance(walletId: string): Promise<void> {
  const initialAllowanceStr = process.env.LNBITS_INITIAL_ALLOWANCE;
  if (!initialAllowanceStr) {
    return;
  }
  const initialAllowance = parseInt(initialAllowanceStr);
  if (isNaN(initialAllowance)) {
    console.error('Invalid initial allowance value:', initialAllowanceStr);
    return;
  }
  await topUpWallet(walletId, initialAllowance);
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
    const aadObjectId = teamsChannelAccount.aadObjectId ;

    let user: User | null = null;
    let lnbitsUsers = await getUsers(adminKey, {
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

      const allowanceWallet = await createWallet(adminKey, user.id, 'Allowance');
      await applyInitialAllowance(allowanceWallet.id);
      user = await updateUser(adminKey, user.id, {
        allowanceWalletId: allowanceWallet.id,
      });
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
      allowanceWallet =
        userWallets.find(w => w.name === 'Allowance') ??
        (await createWallet(adminKey, user.id, 'Allowance'));
      if (allowanceWallet.balance_msat < 1) {
        await applyInitialAllowance(allowanceWallet.id);
      }
      user = await updateUser(adminKey, user.id, {
        allowanceWalletId: allowanceWallet.id,
      });
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
      user = await updateUser(adminKey, user.id, {
        privateWalletId: privateWallet.id,
      });
    }

    this.setCurrentUser(user);
    return user;
  }
}
