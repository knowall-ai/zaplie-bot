import { logger } from '../../utils/logger';
import { getAccessToken } from './auth';
import {
  apiCache,
  isCacheValid,
  pendingRequests,
  CACHE_DURATION_USERS_MS,
} from './cache';
import type { RawApiUser } from './cache';
import { nodeUrl, password, userName } from './config';
import { getUserWallets } from './wallets';

// Mapping to the User type happens in getUsers, not here.
const getAllUsersFromAPI = async (): Promise<RawApiUser[]> => {
  if (isCacheValid(apiCache.rawUsers, CACHE_DURATION_USERS_MS)) {
    logger.debug('[Cache HIT] getAllUsersFromAPI');
    return apiCache.rawUsers.data;
  }

  const pendingUsersRequest = pendingRequests.users;
  if (pendingUsersRequest) {
    logger.debug('[Dedup] Reusing pending getAllUsersFromAPI request');
    return pendingUsersRequest;
  }

  logger.debug('[Cache MISS] Fetching users from API');

  const usersRequest = (async (): Promise<RawApiUser[]> => {
    try {
      const accessToken = await getAccessToken(`${userName}`, `${password}`);

      const response = await fetch(`${nodeUrl}/users/api/v1/user`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        logger.error(
          `getAllUsersFromAPI failed with status: ${response.status}`,
        );
        throw new Error('Failed to fetch users');
      }

      const responseData = await response.json();
      const users = responseData?.data || [];
      const result: RawApiUser[] = Array.isArray(users) ? users : [];

      logger.debug(`Fetched ${result.length} users from API`);

      apiCache.rawUsers = {
        data: result,
        timestamp: Date.now(),
      };

      return result;
    } catch (error) {
      logger.error('Error in getAllUsersFromAPI:', error);
      throw error;
    } finally {
      pendingRequests.users = null;
    }
  })();

  pendingRequests.users = usersRequest;
  return usersRequest;
};

const getUsers = async (
  adminKey: string,
  filterByExtra: { [key: string]: string } | null, // Pass the extra field as an object
): Promise<User[] | null> => {
  logger.debug('=== getUsers ===');
  logger.debug('Fetching users from /users/api/v1/user');
  logger.debug('Filter criteria:', filterByExtra);

  try {
    const rawUsers = await getAllUsersFromAPI();

    if (!rawUsers || rawUsers.length === 0) {
      logger.debug('No users found');
      return [];
    }

    logger.debug(`Found ${rawUsers.length} users`);

    // Debug: Log first user to see available fields
    if (rawUsers.length > 0) {
      logger.debug('=== SAMPLE RAW USER FROM API ===');
      logger.debug('Sample user data:', rawUsers[0]);
      logger.debug('Available fields:', Object.keys(rawUsers[0]));
    }

    // Note: Wallets are NOT fetched here - use separate functions to get wallets when needed
    const users: User[] = rawUsers.map((user: any) => {
      // Try to get a friendly display name from various fields
      let displayName = user.username || user.id;

      // If username is an email, extract the name part
      if (displayName.includes('@')) {
        displayName = displayName.split('@')[0].replace('.', ' ');
        // Capitalize first letter of each word
        displayName = displayName
          .split(' ')
          .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
      }

      return {
        id: user.id,
        displayName: displayName,
        profileImg: user.extra?.profileImg || '', // Get from extra metadata if available
        aadObjectId: user.external_id || user.extra?.aadObjectId || '', // Get from external_id or extra metadata
        email: user.email || user.extra?.email || user.username || '', // Get from user object or extra metadata
        type: (user.extra?.type as UserType) || ('Teammate' as UserType), // Default type
        privateWallet: null, // Wallets should be fetched separately when needed
        allowanceWallet: null, // Wallets should be fetched separately when needed
      };
    });

    // Apply filter if provided
    if (filterByExtra && Object.keys(filterByExtra).length > 0) {
      logger.debug('=== FILTERING USERS ===');

      if (filterByExtra.aadObjectId) {
        logger.debug(
          'Filtering by aadObjectId (external_id):',
          filterByExtra.aadObjectId,
        );

        const filteredUsers = users.filter(user => {
          const userRaw = rawUsers.find((u: any) => u.id === user.id);
          if (!userRaw) return false;

          const matches = userRaw.external_id === filterByExtra.aadObjectId;
          logger.debug(
            `User ${user.displayName}: external_id=${userRaw.external_id}, matches=${matches}`,
          );
          return matches;
        });

        logger.debug(
          `Filtered to ${filteredUsers.length} users by external_id`,
        );
        logger.debug('====================');
        return filteredUsers;
      }

      // Otherwise, filter by extra metadata fields
      logger.debug('Filtering by extra metadata:', filterByExtra);
      const filteredUsers = users.filter(user => {
        const userRaw = rawUsers.find(u => u.id === user.id);
        if (!userRaw || !userRaw.extra) {
          return false;
        }

        // If extra is a string, try to parse it
        let extraData: Record<string, unknown>;
        if (typeof userRaw.extra === 'string') {
          try {
            extraData = JSON.parse(userRaw.extra);
          } catch (e) {
            return false;
          }
        } else {
          extraData = userRaw.extra;
        }

        return Object.keys(filterByExtra).every(
          key => extraData[key] === filterByExtra[key],
        );
      });

      logger.debug(
        `Filtered to ${filteredUsers.length} users by extra metadata`,
      );
      logger.debug('====================');
      return filteredUsers;
    }

    logger.debug('Returning all users');
    return users;
  } catch (error) {
    logger.error('Error fetching users:', error);
    throw error;
  }
};

const getUser = async (
  adminKey: string,
  userId: string,
): Promise<User | null> => {
  if (!userId || userId === '' || userId === 'undefined') {
    return null;
  }

  try {
    const userWallets = await getUserWallets(adminKey, userId);

    if (!userWallets || userWallets.length === 0) {
      return null;
    }

    // Find private and allowance wallets
    const privateWallet =
      userWallets.find(w => w.name.toLowerCase().includes('private')) || null;

    const allowanceWallet =
      userWallets.find(w => w.name.toLowerCase().includes('allowance')) || null;

    // Extract display name from wallet name
    let displayName = userId;
    if (privateWallet) {
      // Try to extract name from private wallet (format: "UserName - Private")
      const nameParts = privateWallet.name.split('-');
      if (nameParts.length > 1) {
        displayName = nameParts[0].trim();
      }
    } else if (userWallets.length > 0) {
      const nameParts = userWallets[0].name.split('-');
      if (nameParts.length > 1) {
        displayName = nameParts[0].trim();
      }
    }

    return {
      id: userId,
      displayName: displayName,
      profileImg: '', // Will be populated from application layer if needed
      aadObjectId: '', // Will be populated from application layer if needed
      email: '', // Will be populated from application layer if needed
      type: 'Teammate' as UserType, // Default type
      privateWallet: privateWallet,
      allowanceWallet: allowanceWallet,
    };
  } catch (error) {
    logger.error(`Error fetching user ${userId}:`, error);
    throw error;
  }
};

const getAllowance = async (
  adminKey: string,
  userId: string,
): Promise<Allowance | null> => {
  try {
    // TODO: Implement the actual API call to fetch the allowance
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 (Sunday) to 6 (Saturday)
    const daysUntilNextMonday = (8 - dayOfWeek) % 7 || 7; // Calculate days until next Monday
    const nextPaymentDate = new Date(
      today.setDate(today.getDate() + daysUntilNextMonday),
    );
    const daysSinceLastMonday = (dayOfWeek + 6) % 7; // Calculate days since last Monday
    const lastPaymentDate = new Date(
      today.setDate(today.getDate() - daysSinceLastMonday),
    );

    const allowance: Allowance = {
      id: '123',
      name: 'Allowance',
      wallet: '123456789',
      toWallet: '123456789',
      amount: 25000,
      startDate: new Date(),
      endDate: null,
      frequency: 'Monthly',
      nextPaymentDate: nextPaymentDate,
      lastPaymentDate: lastPaymentDate,
      memo: "Don't spend it all at once",
      active: true,
    };
    return allowance;
  } catch (error) {
    logger.error(`Error fetching allowances for ${userId}:`, error);
    throw error; // Re-throw the error to handle it in the parent function
  }
};

export { getAllUsersFromAPI, getUsers, getUser, getAllowance };
