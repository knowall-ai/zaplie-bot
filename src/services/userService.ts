// userService.ts

/// <reference path="../../src/types/global.d.ts" />

import { ConsoleTranscriptLogger, TurnContext } from 'botbuilder';
import {
  getUsers,
  createUser,
  createWallet,
  updateUser,
  getUserWallets,
} from './lnbitsService';

const adminKey = process.env.LNBITS_ADMINKEY as string;

export class UserService {
  private static instance: UserService;
  private users: Map<string, User> = new Map(); // Simple in-memory cache

  private constructor() {}

  public static getInstance(): UserService {
    if (!UserService.instance) {
      UserService.instance = new UserService();
    }
    return UserService.instance;
  }

  public async getUser(context: TurnContext): Promise<User> {
    const userId = context.activity.from.id;

    // Check if the user is already in memory (in-session)
    if (this.users.has(userId)) {
      return this.users.get(userId)!;
    }

    // Otherwise, create or fetch the user from the external service
    let currentUser: User;

    // Fetch user details from LNBits (assuming LNBits is an external service)
    const users: User[] = await getUsers(adminKey, {
      aadObjectId: context.activity.from.aadObjectId,
    });

    if (users.length < 1) {
      console.log('User does not exist ... creating a new one');
      const extra = {
        aadObjectId: context.activity.from.aadObjectId,
        profileImg:
          'https://hiberniaevros.sharepoint.com/_layouts/15/userphoto.aspx?AccountName=' +
          context.activity.from.properties?.email,
        privateWalletId: null,
        allowanceWalletId: null,
        userType: 'teammate',
      };

      currentUser = await createUser(
        adminKey,
        context.activity.from.name,
        'Private',
        'someone@somewhere.com', // Placeholder for email
        'password1',
        extra,
      );

      // Create their allowance wallet
      const allowanceWallet = await createWallet(
        adminKey,
        currentUser.id,
        'Allowance',
      );
      currentUser = await updateUser(adminKey, currentUser.id, {
        allowanceWalletId: allowanceWallet.id,
        privateWalletId: currentUser.privateWallet?.id,
      });
    } else {
      currentUser = users[0];
    }

    // Store the user in memory to avoid fetching again during the session
    this.users.set(userId, currentUser);

    return currentUser;
  }
}
