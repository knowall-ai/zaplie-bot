import { logger } from '../../utils/logger';
import { getAccessToken } from './auth';
import {
  apiCache,
  isCacheValid,
  pendingRequests,
  CACHE_DURATION_WALLETS_MS,
  MAX_WALLET_CACHE_SIZE,
} from './cache';
import { nodeUrl, password, userName } from './config';

const getWallets = async (
  filterByName?: string,
  filterById?: string,
): Promise<Wallet[] | null> => {
  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);
    const response = await fetch(`${nodeUrl}/api/v1/wallets`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        //'X-Api-Key': apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Error getting wallets response (status: ${response.status})`,
      );
    }

    const data: Wallet[] = (await response.json()) as Wallet[];

    // If filter is provided, filter the wallets by name and/or id
    let filteredData = data;
    if (filterByName) {
      filteredData = filteredData.filter(wallet =>
        wallet.name.includes(filterByName),
      );
    }
    if (filterById) {
      filteredData = filteredData.filter(wallet => wallet.id === filterById);
    }

    return filteredData;
  } catch (error) {
    logger.error(error);
    throw error;
  }
};

const getWalletDetails = async (inKey: string, walletId: string) => {
  try {
    const response = await fetch(`${nodeUrl}/api/v1/wallets/${walletId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': inKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Error getting wallet details (status: ${response.status})`,
      );
    }

    const data = await response.json();

    return data;
  } catch (error) {
    logger.error(error);
    throw error;
  }
};

const getWalletBalance = async (inKey: string) => {
  try {
    const response = await fetch(`${nodeUrl}/api/v1/wallet`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': inKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Error getting wallet balance (status: ${response.status})`,
      );
    }

    const data = await response.json();

    return data.balance / 1000; // return in Sats (not millisatoshis)
  } catch (error) {
    logger.error(error);
    throw error;
  }
};

const getUserWallets = async (
  adminKey: string,
  userId: string,
): Promise<Wallet[] | null> => {
  const cachedEntry = apiCache.userWallets.get(userId);
  if (isCacheValid(cachedEntry, CACHE_DURATION_WALLETS_MS)) {
    logger.debug(`[Cache HIT] getUserWallets for user ${userId}`);
    return cachedEntry.data;
  }

  const pendingRequest = pendingRequests.userWallets.get(userId);
  if (pendingRequest) {
    logger.debug(
      `[Dedup] Reusing pending getUserWallets request for user ${userId}`,
    );
    return pendingRequest;
  }

  const requestPromise = (async (): Promise<Wallet[] | null> => {
    try {
      const accessToken = await getAccessToken(`${userName}`, `${password}`);
      const response = await fetch(
        `${nodeUrl}/users/api/v1/user/${userId}/wallet`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            //'X-Api-Key': adminKey,
          },
        },
      );

      if (!response.ok) {
        throw new Error(
          `Error getting users wallets response (status: ${response.status})`,
        );
      }

      const data: Wallet[] = await response.json();

      let walletData: Wallet[] = data.map((wallet: any) => ({
        id: wallet.id,
        admin: wallet.admin || '', // TODO: To be implemented. Ref: https://t.me/lnbits/90188
        name: wallet.name,
        adminkey: wallet.adminkey,
        user: wallet.user,
        inkey: wallet.inkey,
        balance_msat: wallet.balance_msat, // TODO: To be implemented. Ref: https://t.me/lnbits/90188
        deleted: wallet.deleted,
      }));

      // Now remove the deleted wallets.
      const filteredWallets = walletData.filter(
        wallet => wallet.deleted !== true,
      );

      // Limit cache size to prevent unbounded memory growth
      if (apiCache.userWallets.size >= MAX_WALLET_CACHE_SIZE) {
        const firstKey = apiCache.userWallets.keys().next().value;
        if (firstKey) {
          apiCache.userWallets.delete(firstKey);
        }
      }

      apiCache.userWallets.set(userId, {
        data: filteredWallets,
        timestamp: Date.now(),
      });

      return filteredWallets;
    } catch (error) {
      logger.error('Error fetching user wallets:', error);
      throw error;
    } finally {
      pendingRequests.userWallets.delete(userId);
    }
  })();

  pendingRequests.userWallets.set(userId, requestPromise);
  return requestPromise;
};

const getWalletName = async (inKey: string) => {
  try {
    const response = await fetch(`${nodeUrl}/api/v1/wallet`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': inKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Error getting wallet name (status: ${response.status})`);
    }

    const data = await response.json();

    return data.name;
  } catch (error) {
    logger.error(error);
    throw error;
  }
};

const getWalletPayLinks = async (inKey: string, walletId: string) => {
  try {
    const response = await fetch(
      `${nodeUrl}/lnurlp/api/v1/links?all_wallets=false&wallet=${walletId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': inKey,
        },
      },
    );

    if (!response.ok) {
      logger.error(
        `Error getting paylinks for wallet (status: ${response.status})`,
      );
      return null;
    }

    const data = await response.json();

    return data;
  } catch (error) {
    logger.error(error);
    throw error;
  }
};

// May need fixing!
const getWalletId = async (inKey: string) => {
  try {
    const response = await fetch(`${nodeUrl}/api/v1/wallets`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': inKey,
      },
    });

    if (!response.ok) {
      logger.error(`Error getting wallet ID (status: ${response.status})`);
      return null;
    }

    const data = await response.json();

    // Find the wallet with a matching inkey
    const wallet = data.find((wallet: any) => wallet.inkey === inKey);

    if (!wallet) {
      logger.error('No wallet found for this inKey.');
      return null;
    }

    return wallet.id;
  } catch (error) {
    logger.error(error);
    throw error;
  }
};

const getAllWallets = async (lnKey: string) => {
  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);

    const response = await fetch(`${nodeUrl}/api/v1/wallets`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      logger.error('Response status:', response.status);
      logger.error('Response statusText:', response.statusText);
      throw new Error(`Error getting wallets (status: ${response.status})`);
    }

    const data: Wallet[] = await response.json();

    logger.debug('All Wallets returned:', data.length);
    logger.debug('All Wallets: ', data);

    let walletData: Wallet[] = data.map((wallet: any) => ({
      id: wallet.id,
      admin: wallet.admin || '', // TODO: To be implemented. Ref: https://t.me/lnbits/90188
      name: wallet.name,
      adminkey: wallet.adminkey,
      user: wallet.user,
      inkey: wallet.inkey,
      balance_msat: wallet.balance_msat, // TODO: To be implemented. Ref: https://t.me/lnbits/90188
      deleted: wallet.deleted,
    }));

    // Now remove the deleted wallets.
    const filteredWallets = walletData.filter(
      wallet => wallet.deleted !== true,
    );

    logger.debug('Filtered wallets count:', filteredWallets.length);
    return filteredWallets;
  } catch (error) {
    logger.error('Error in getAllWallets:', error);
    throw error;
  }
};

const createWallet = async (
  apiKey: string,
  objectID: string,
  displayName: string,
) => {
  try {
    const url = `${nodeUrl}/api/v1/wallet`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `${displayName}`,
      }),
    });

    if (!response.ok) {
      throw new Error(`Error creating wallet (${response.statusText})`);
    }

    const data = await response.json();

    return data;
  } catch (error) {
    logger.error(error);
    throw error;
  }
};

// TODO: This method needs checking!
const getWalletIdByUserId = async (adminKey: string, userId: string) => {
  try {
    const response = await fetch(
      `${nodeUrl}/api/v1/wallets?user_id=${userId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': adminKey,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Error getting wallet ID from the user ID (status: ${response.status})`,
      );
    }

    const data = await response.json();

    return data.id;
  } catch (error) {
    logger.error(error);
    return null;
  }
};

const getWalletsPaginated = async (
  userId: string,
  limit: number = 100,
  offset: number = 0,
): Promise<Wallet[]> => {
  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);

    const url = new URL(`${nodeUrl}/api/v1/wallet/paginated`);
    url.searchParams.append('limit', limit.toString());
    url.searchParams.append('offset', offset.toString());
    url.searchParams.append('user_id', userId);

    logger.debug('>>> Full URL with params:', url.toString());

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      logger.error('Response status:', response.status);
      logger.error('Response statusText:', response);
      throw new Error(
        `Error getting wallets for user ${userId} (status: ${response.status})`,
      );
    }

    const responseData = await response.json();
    logger.debug(`>>> Raw response for user ${userId}:`, responseData);

    // Extract the wallets array from the response (API returns {data: [...], total: X})
    const wallets = responseData?.data || [];
    logger.debug(`>>> Extracted ${wallets.length} wallets from response`);

    // DEBUG: Show the wallet.user field for each wallet to verify they match the requested userId
    logger.debug(`>>> WALLET USER IDs FOR REQUESTED USER ${userId}:`);
    wallets.forEach((wallet: any, index: number) => {
      logger.debug(
        `  Wallet ${index + 1}: ID=${wallet.id}, Name="${wallet.name}", User ID=${wallet.user}, Matches=${wallet.user === userId ? '✓' : '✗'}`,
      );
    });

    const walletData: Wallet[] = wallets.map((wallet: any) => ({
      id: wallet.id,
      admin: wallet.admin || '',
      name: wallet.name,
      user: wallet.user,
      adminkey: wallet.adminkey,
      inkey: wallet.inkey,
      balance_msat: wallet.balance_msat,
      deleted: wallet.deleted || false,
      // Additional fields that might come from the API
      currency: wallet.currency,
      created_at: wallet.created_at,
      updated_at: wallet.updated_at,
    }));

    const filteredWallets = walletData.filter(
      wallet => wallet.deleted !== true,
    );

    logger.debug(
      `>>> Filtered wallets count for user ${userId}:`,
      filteredWallets.length,
    );
    logger.debug(
      `>>> Wallet IDs: [${filteredWallets.map(w => w.id).join(', ')}]`,
    );
    logger.debug('===========================');

    return filteredWallets;
  } catch (error) {
    logger.error(`Error in getWalletsPaginated for user ${userId}:`, error);
    throw error;
  }
};

export {
  getWallets,
  getWalletDetails,
  getWalletBalance,
  getUserWallets,
  getWalletName,
  getWalletPayLinks,
  getWalletId,
  getAllWallets,
  createWallet,
  getWalletIdByUserId,
  getWalletsPaginated,
};
