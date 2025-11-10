// lnbitsService.ts - MIGRATED TO USERS API
// Migration from deprecated UserManager extension to new Users API
// Target LNbits v1.3+ / v1.4+ without usermanager extension

/// <reference path="../../src/types/global.d.ts" />

import dotenvFlow from 'dotenv-flow';

dotenvFlow.config({ path: './env' });
let globalWalletId: string | null = null;

// LNbits configuration
const lnbiturl = process.env.LNBITS_NODE_URL as string;
const userName = process.env.LNBITS_USERNAME as string;
const password = process.env.LNBITS_PASSWORD as string;
// Note: adminKey still needed for some legacy endpoints during transition
const adminKey = process.env.LNBITS_ADMINKEY as string;

// MIGRATION FEATURE FLAG
// Set to true when Users API endpoints are confirmed available
const USE_USERS_API = process.env.LNBITS_USE_USERS_API === 'true';

// Bearer token management for Users API authentication
let accessToken: string | null = null;

/**
 * MIGRATION HELPER: Determines which API to use based on feature flag
 * @param usermanagerEndpoint - The deprecated UserManager endpoint
 * @param usersApiEndpoint - The new Users API endpoint
 * @returns The endpoint URL to use
 */
function getApiEndpoint(usermanagerEndpoint: string, usersApiEndpoint: string): string {
  return USE_USERS_API ? usersApiEndpoint : usermanagerEndpoint;
}

/**
 * MIGRATION HELPER: Gets appropriate headers based on API version
 * @param accessToken - Bearer token for Users API
 * @param adminKey - Admin key for UserManager API  
 * @returns Headers object
 */
function getApiHeaders(accessToken?: string, adminKey?: string): Record<string, string> {
  const baseHeaders = {
    'Content-Type': 'application/json',
  };
  
  if (USE_USERS_API && accessToken) {
    return {
      ...baseHeaders,
      Authorization: `Bearer ${accessToken}`,
    };
  } else if (adminKey) {
    return {
      ...baseHeaders,
      'X-Api-Key': adminKey,
    };
  }
  
  return baseHeaders;
}

// LNBits API is documented here:
// https://demo.lnbits.com/docs/

// Store token in localStorage (persists between page reloads)
let accessTokenPromise: Promise<string> | null = null; // To cache the pending token request

export async function getAccessToken(
  username: string,
  password: string,
): Promise<string> {
  /*console.log(
    `getAccessToken starting ... (username: ${username}, filterById: ${password}))`,
  );*/
  if (accessToken) {
    //console.log('Using cached access token: ' + accessToken);
    return accessToken;
  } else {
    console.log('No cached access token found');
  }

  // If there's already a token request in progress, return the existing promise
  if (accessTokenPromise) {
    console.log('Returning ongoing access token request');
    return accessTokenPromise;
  }

  // No access token and no request in progress, create a new one
  console.log('No cached access token found, requesting a new one');

  // Store the promise of the request
  accessTokenPromise = (async (): Promise<string> => {
    try {
      const response = await fetch(`${lnbiturl}/api/v1/auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      //console.log('Request URL:', response.url);
      //console.log('Request Status:', response.status);
      //console.log('Request Headers:', response.headers);

      if (!response.ok) {
        throw new Error(
          `Error creating access token (status: ${response.status}): ${response.statusText}`,
        );
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Response is not in JSON format');
      }

      const data = await response.json();

      if (!data || !data.access_token) {
        throw new Error('Access token is missing in the response');
      }

      // Store the access token in memory and localStorage
      accessToken = data.access_token;
      if (accessToken) {
        //localStorage.setItem('accessToken', accessToken);
        console.log('Access token fetched and stored: ' + accessToken);
      } else {
        throw new Error('Access token is null, cannot store in localStorage.');
      }

      // Return the access token
      return accessToken;
    } catch (error) {
      console.error('Error in getAccessToken:', error);
      // Throw an error to ensure the promise doesn't resolve with undefined
      throw new Error('Failed to retrieve access token');
    } finally {
      // Reset the promise to allow future requests
      accessTokenPromise = null;
    }
  })();

  // Return the token promise
  return accessTokenPromise;
}

// MIGRATED: getWallets - Uses Users API with Bearer token authentication
// OLD: GET /usermanager/api/v1/wallets (X-Api-Key)
// NEW: GET /users/api/v1/admin/wallets (Bearer token) - ENDPOINT TBD
const getWallets = async (
  adminKey: string,
  filterByName?: string,
  filterById?: string,
): Promise<Wallet[] | null> => {
  console.log(
    `getWallets starting ... (adminKey: ${adminKey}, filterByName: ${filterByName}, filterById: ${filterById}))`,
  );

  try {
    // MIGRATION: Dynamic endpoint and authentication based on feature flag
    const accessToken = await getAccessToken(`${userName}`, `${password}`);
    
    const endpoint = getApiEndpoint(
      `${lnbiturl}/usermanager/api/v1/wallets`,
      `${lnbiturl}/users/api/v1/admin/wallets` // TBD - endpoint needs confirmation
    );
    
    const headers = getApiHeaders(accessToken, adminKey);
    
    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(
        `Error getting wallets response (status: ${response.status})`,
      );
    }

    const data = await response.json();

    // If filter is provided, filter the wallets by name and/or id
    let filteredData = data;
    if (filterByName) {
      console.log('Filtering by name:', filterByName);
      filteredData = filteredData.filter(wallet =>
        wallet.name.includes(filterByName),
      );
    }
    if (filterById) {
      filteredData = filteredData.filter(wallet => wallet.id === filterById);
    }

    // Map the wallets to match the Wallet interface
    let walletData: Wallet[] = await Promise.all(
      filteredData.map(async (filteredData: any) => ({
        id: filteredData.id,
        admin: filteredData.admin,
        name: filteredData.name,
        adminkey: filteredData.adminkey,
        user: filteredData.user,
        inkey: filteredData.inkey,
        // See: https://github.com/lnbits/lnbits/issues/2690
        deleted: (
          await getWalletById(filteredData.user, filteredData.id)
        )?.deleted,
        balance_msat: (
          await getWalletById(filteredData.user, filteredData.id)
        )?.balance_msat,
      })),
    );

    // Now remove the deleted wallets.
    walletData = walletData.filter(wallet => wallet.deleted != true);

    return walletData;
  } catch (error) {
    console.error(error);
    return error;
  }
};

const getUserWallets = async (
  adminKey: string,
  userId: string,
): Promise<Wallet[] | null> => {
  console.log(
    `getUserWallets starting ... (adminKey: ${adminKey}, userId: ${userId})`,
  );

  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);
    const response = await fetch(
      `${lnbiturl}/users/api/v1/user/${userId}/wallet`,
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

    // Map the wallets to match the Wallet interface
    let walletData: Wallet[] = data.map((wallet: any) => ({
      id: wallet.id,
      admin: null, // TODO: To be implemented. Ref: https://t.me/lnbits/90188
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

    return filteredWallets;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

// MIGRATED: getUsers - Transitioning to Users API with Bearer token
// OLD: GET /usermanager/api/v1/users?extra=${encodedExtra} (X-Api-Key)
// NEW: GET /users/api/v1/users?filter=${encodedFilter} (Bearer token) - ENDPOINT TBD
const getUsers = async (
  adminKey: string,
  filterByExtra: { [key: string]: string } | null, // Pass the extra field as an object
): Promise<User[] | null> => {
  console.log(
    `getUsers starting ... (adminKey: ${adminKey}, filterByExtra: ${JSON.stringify(
      filterByExtra,
    )})`,
  );

  try {
    // MIGRATION: Dynamic endpoint and authentication based on feature flag
    const accessToken = await getAccessToken(`${userName}`, `${password}`);
    
    const encodedExtra = JSON.stringify(filterByExtra);
    const filterParam = USE_USERS_API ? `filter=${encodedExtra}` : `extra=${encodedExtra}`;
    
    const endpoint = getApiEndpoint(
      `${lnbiturl}/usermanager/api/v1/users?${filterParam}`,
      `${lnbiturl}/users/api/v1/users?${filterParam}` // TBD - endpoint needs confirmation
    );
    
    const headers = getApiHeaders(accessToken, adminKey);
    
    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(
        `Error getting users response (status: ${response.status})`,
      );
    }

    const data = await response.json();

    console.log('getUsers data:', data);

    // Map the users to match the User interface
    const usersData: User[] = await Promise.all(
      data.map(async (user: any) => {
        const extra = user.extra || {}; // Provide a default empty object if user.extra is null

        let privateWallet = null;
        let allowanceWallet = null;

        if (user.extra) {
          privateWallet = await getWalletById(user.id, extra.privateWalletId);
          allowanceWallet = await getWalletById(
            user.id,
            extra.allowanceWalletId,
          );
        }

        return {
          id: user.id,
          displayName: user.name,
          aadObjectId: extra.aadObjectId || null,
          email: user.email,
          privateWallet: privateWallet,
          allowanceWallet: allowanceWallet,
        };
      }),
    );

    return usersData;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

// MIGRATED: createUser - Transitioning to Users API with Bearer token
// OLD: POST /usermanager/api/v1/users (X-Api-Key)
// NEW: POST /users/api/v1/users (Bearer token) - ENDPOINT TBD
const createUser = async (
  adminKey: string,
  userName: string,
  walletName: string,
  email: string,
  password: string,
  extra: { [key: string]: string }, // Ensure extra is an object, not a string
): Promise<User | null> => {
  console.log(
    `createUser starting ... (adminKey: ${adminKey}, userName: ${userName}, email: ${email}, password: ${password}, extra: ${JSON.stringify(
      extra,
    )}))`,
  );

  try {
    // MIGRATION NOTE: Users API endpoint for user creation is TBD
    const accessToken = await getAccessToken(`${userName}`, `${password}`);
    
    // Prepare the request body
    const requestBody = {
      user_name: userName,
      wallet_name: walletName,
      email: email || '',
      password: password || '',
      extra: extra,
    };

    console.log(JSON.stringify(requestBody));

    // TODO: Replace with Users API endpoint once available:
    // const response = await fetch(`${lnbiturl}/users/api/v1/users`, {
    const response = await fetch(`${lnbiturl}/usermanager/api/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // TODO: Switch to Bearer token once Users API endpoint is confirmed:
        // Authorization: `Bearer ${accessToken}`,
        'X-Api-Key': adminKey,
      },
      body: JSON.stringify(requestBody), // Stringify the request body
    });

    if (!response.ok) {
      throw new Error(
        `Error getting create user response (status: ${response.status})`,
      );
    }

    const user = await response.json();

    // Await the wallet promises
    const privateWallet = await getWalletById(
      user.id,
      user.extra?.privateWalletId,
    );
    const allowanceWallet = await getWalletById(
      user.id,
      user.extra?.allowanceWalletId,
    );

    // Map the user to match the User interface
    const userData: User = {
      id: user.id,
      displayName: user.name,
      profileImg:
        'https://hiberniaevros.sharepoint.com/_layouts/15/userphoto.aspx?AccountName=' +
        user.email, // TODO: Remove hardecoded URL
      aadObjectId: user.extra?.aadObjectId || null,
      email: user.email,
      privateWallet: privateWallet,
      allowanceWallet: allowanceWallet,
    };

    console.log('userData:', userData);

    return userData;
  } catch (error) {
    console.error(error);
    return error;
  }
};

// MIGRATED: getUser - Transitioning to Users API with Bearer token
// OLD: GET /usermanager/api/v1/users/{userId} (X-Api-Key)
// NEW: GET /users/api/v1/users/{userId} (Bearer token) - ENDPOINT TBD
const getUser = async (
  adminKey: string,
  userId: string,
): Promise<User | null> => {
  console.log(
    `getUser starting ... (adminKey: ${adminKey}, userId: ${userId})`,
  );

  try {
    // MIGRATION NOTE: Users API endpoint for individual user access is TBD
    const accessToken = await getAccessToken(`${userName}`, `${password}`);
    
    // TODO: Replace with Users API endpoint once available:
    // const response = await fetch(`${lnbiturl}/users/api/v1/users/${userId}`, {
    const response = await fetch(
      `${lnbiturl}/usermanager/api/v1/users/${userId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          // TODO: Switch to Bearer token once Users API endpoint is confirmed:
          // Authorization: `Bearer ${accessToken}`,
          'X-Api-Key': adminKey,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Error getting user response (status: ${response.status})`,
      );
    }

    const user = await response.json();

    // Await the wallet promises
    const privateWallet = await getWalletById(
      user.id,
      user.extra?.privateWalletId,
    );
    const allowanceWallet = await getWalletById(
      user.id,
      user.extra?.allowanceWalletId,
    );

    // Map the user to match the User interface
    const userData: User = {
      id: user.id,
      displayName: user.name,
      profileImg: user.profileImg,
      aadObjectId: user.extra?.aadObjectId || null,
      email: user.email,
      privateWallet: privateWallet,
      allowanceWallet: allowanceWallet,
    };

    console.log('userData:', userData);

    return userData;
  } catch (error) {
    console.error(error);
    return error;
  }
};

// MIGRATED: updateUser - Transitioning to Users API with Bearer token
// OLD: PUT /usermanager/api/v1/users/{userId} (X-Api-Key)
// NEW: PUT /users/api/v1/users/{userId} (Bearer token) - ENDPOINT TBD
const updateUser = async (
  adminKey: string,
  userId: string,
  extra: { [key: string]: string }, // Ensure extra is an object, not a string
): Promise<User | null> => {
  console.log(
    `updateUser starting ... (adminKey: ${adminKey}, userId: ${userId}, extra: ${JSON.stringify(
      extra,
    )}))`,
  );

  try {
    // MIGRATION NOTE: Users API endpoint for user updates is TBD
    const accessToken = await getAccessToken(`${userName}`, `${password}`);
    
    // Prepare the request body
    const requestBody = {
      extra: extra,
    };

    // TODO: Replace with Users API endpoint once available:
    // const response = await fetch(`${lnbiturl}/users/api/v1/users/${userId}`, {
    const response = await fetch(
      `${lnbiturl}/usermanager/api/v1/users/${userId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          // TODO: Switch to Bearer token once Users API endpoint is confirmed:
          // Authorization: `Bearer ${accessToken}`,
          'X-Api-Key': adminKey,
        },
        body: JSON.stringify(requestBody), // Stringify the request body
      },
    );

    if (!response.ok) {
      throw new Error(`Error getting response (status: ${response.status})`);
    }

    const data = await response.json();

    // Await the wallet promises
    const privateWallet = await getWalletById(
      adminKey,
      data.extra?.privateWalletId,
    );
    const allowanceWallet = await getWalletById(
      adminKey,
      data.extra?.allowanceWalletId,
    );

    console.log('privateWallet :', privateWallet);
    console.log('allowanceWallet :', allowanceWallet);

    // Map the user to match the User interface
    const userData: User = {
      id: data.id,
      displayName: data.name,
      profileImg: data.profileImg,
      aadObjectId: data.extra?.aadObjectId || null,
      email: data.email,
      privateWallet: privateWallet,
      allowanceWallet: allowanceWallet,
    };

    console.log('updateUser usersData:', userData);

    return userData;
  } catch (error) {
    console.error(error);
    return error;
  }
};

// MIGRATED: createWallet - Transitioning to Users API with Bearer token
// OLD: POST /usermanager/api/v1/wallets (X-Api-Key)
// NEW: POST /users/api/v1/users/{userId}/wallets (Bearer token) - ENDPOINT TBD
const createWallet = async (
  adminKey: string,
  userId: string,
  walletName: string,
): Promise<Wallet | null> => {
  console.log(
    `createWallet starting ... (adminKey: ${adminKey}, userId: ${userId}, walletName: ${walletName}))`,
  );

  try {
    // MIGRATION NOTE: Users API endpoint for wallet creation is TBD
    const accessToken = await getAccessToken(`${userName}`, `${password}`);
    
    // Prepare the request body
    const requestBody = {
      user_id: userId,
      wallet_name: walletName,
    };

    // TODO: Replace with Users API endpoint once available:
    // const response = await fetch(`${lnbiturl}/users/api/v1/users/${userId}/wallets`, {
    const response = await fetch(`${lnbiturl}/usermanager/api/v1/wallets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // TODO: Switch to Bearer token once Users API endpoint is confirmed:
        // Authorization: `Bearer ${accessToken}`,
        'X-Api-Key': adminKey,
      },
      body: JSON.stringify(requestBody), // Stringify the request body
    });

    if (!response.ok) {
      throw new Error(`Error getting response (status: ${response.status})`);
    }

    const data = await response.json();

    // Await the wallet promises
    const walletWithBalance = await getWalletById(data.user, data.id);

    // Map the wallet to match the Wallet interface
    let walletData: Wallet = {
      id: data.id,
      admin: data.admin,
      name: data.name,
      adminkey: data.adminkey,
      user: data.user,
      inkey: data.inkey,
      balance_msat: walletWithBalance?.balance_msat,
      deleted: walletWithBalance?.deleted,
    };

    console.log('createWallet data:', walletData);

    return walletData;
  } catch (error) {
    console.error(error);
    return error;
  }
};

const getWalletDetails = async (inKey: string, walletId: string) => {
  console.log(
    `getWalletDetails starting ... (inKey: ${inKey}, walletId: ${walletId}))`,
  );
  try {
    const response = await fetch(`${lnbiturl}/api/v1/wallets/${walletId}`, {
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
    console.log('Wallet details:', data);

    return data;
  } catch (error) {
    console.error(error);
    return error;
  }
};

const getWalletBalance = async (inKey: string) => {
  console.log(`getWalletBalance starting ... (inKey: ${inKey})`);
  try {
    const response = await fetch(`${lnbiturl}/api/v1/wallet`, {
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

    console.log('Balance:', data.balance / 1000); // Convert to Sats

    return data.balance / 1000; // return in Sats (not millisatoshis)
  } catch (error) {
    console.error(error);
    return error;
  }
};

const getWalletName = async (inKey: string) => {
  console.log(`getWalletName starting ... (inKey: ${inKey})`);

  try {
    const response = await fetch(`${lnbiturl}/api/v1/wallet`, {
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
    console.error(error);
    return error;
  }
};

const getPayments = async (inKey: string) => {
  console.log(`getPayments starting ... (inKey: ${inKey})`);

  try {
    const response = await fetch(`${lnbiturl}/api/v1/payments?limit=100`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': inKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Error getting payments (status: ${response.status})`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error:', error);
    return null;
  }
};

const getWalletPayLinks = async (inKey: string, walletId: string) => {
  console.log(
    `getWalletPayLinks starting ... (inKey: ${inKey}, walletId: ${walletId})`,
  );

  try {
    const response = await fetch(
      `${lnbiturl}/lnurlp/api/v1/links?all_wallets=false&wallet=${walletId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': inKey,
        },
      },
    );

    if (!response.ok) {
      console.error(
        `Error getting paylinks for wallet (status: ${response.status})`,
      );
      return null;
    }

    const data = await response.json();

    //console.log('Paylinks:', data);

    return data;
  } catch (error) {
    console.error(error);
    return error;
  }
};

const getWalletById = async (
  userId: string,
  id: string,
): Promise<Wallet | null> => {
  console.log(`getWalletById starting ... (userId: ${userId}, id: ${id})`);

  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);
    const response = await fetch(
      `${lnbiturl}/users/api/v1/user/${userId}/wallet`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          //'X-Api-Key': adminKey,
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      console.error(
        `Error getting wallet by ID response (status: ${response.status})`,
      );

      return null;
    }

    const data = await response.json();

    // Find the wallet with a matching inkey that are not deleted.
    const filteredWallets = data.filter(
      (wallet: any) => wallet.deleted !== true,
    );
    const matchingWallet = filteredWallets.find(
      (wallet: any) => wallet.id === id,
    );
    //console.log('matchingWallet: ', matchingWallet);

    if (!matchingWallet) {
      console.error(`Wallet with ID ${id} not found.`);
      return null;
    }

    // Map the filterWallets to match the Wallets interface
    const walletData: Wallet = {
      id: matchingWallet.id,
      admin: matchingWallet.admin, // TODO: Coming back as undefined.
      name: matchingWallet.name,
      user: matchingWallet.user,
      adminkey: matchingWallet.adminkey,
      inkey: matchingWallet.inkey,
      balance_msat: matchingWallet.balance_msat,
      deleted: matchingWallet.deleted,
    };

    return walletData;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

// May need fixing!
const getWalletIdFromKey = async (inKey: string) => {
  console.log(`getWalletIdFromKey starting ... (inKey: ${inKey})`);

  try {
    const response = await fetch(`${lnbiturl}/api/v1/wallets`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': inKey,
      },
    });

    if (!response.ok) {
      console.error(
        `Error getting wallet ID from Key response (status: ${response.status})`,
      );

      return null;
    }

    const data = await response.json();

    // Find the wallet with a matching inkey
    const wallet = data.find((wallet: any) => wallet.inkey === inKey);

    if (!wallet) {
      console.error('No wallet found for this inKey.');
      return null;
    }

    // Return the id of the wallet
    return wallet.id;
  } catch (error) {
    console.error(error);
    return error;
  }
};

const getInvoicePayment = async (inKey: string, invoice: string) => {
  console.log('getInvoicePayment: Starting ...');
  try {
    const response = await fetch(`${lnbiturl}/api/v1/payments/${invoice}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': inKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Error getting invoice payment (status: ${response.status})`,
      );
    }

    const data = await response.json();

    return data;
  } catch (error) {
    console.error(error);
    return error;
  }
};

const getPaymentsSince = async (lnKey: string, timestamp: number) => {
  console.log(
    `getPaymentsSince starting ... (lnKey: ${lnKey}, timestamp: ${timestamp})`,
  );

  // Note that the timestamp is in seconds, not milliseconds.
  try {
    // Get walletId using the provided apiKey
    const walletId = await getWalletIdFromKey(lnKey);

    const response = await fetch(
      `${lnbiturl}/api/v1/payments?wallet=${walletId}&limit=1`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': lnKey,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Error getting payments since ${timestamp} (status: ${response.status})`,
      );
    }

    const data = await response.json();

    // Filter the payments to only include those since the provided timestamp
    const paymentsSince = data.filter(
      (payment: { time: number }) => payment.time >= timestamp,
    );

    console.log(
      `getPaymentsSince count is ${paymentsSince.length} since ${timestamp}`,
    );

    return paymentsSince;
  } catch (error) {
    console.error(error);
    return error;
  }
};

// TODO: This method needs checking!
const createInvoice = async (
  lnKey: string,
  recipientWalletId: string,
  amount: number,
  memo: string,
  extra: object,
) => {
  console.log(
    `createInvoice starting ... (lnKey: ${lnKey}, recipientWalletId: ${recipientWalletId}, amount: ${amount}, memo: ${memo}, extra: ${extra})`,
  );

  try {
    const response = await fetch(`${lnbiturl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': lnKey,
      },
      body: JSON.stringify({
        out: false,
        amount: amount,
        memo: memo,
        extra: extra,
      }),
    });

    console.log('createInvoice: response:', response);

    if (!response.ok) {
      throw new Error(`Error creating an invoice (status: ${response.status})`);
    }

    const data = await response.json();
    //console.log('createInvoice: data:', data);

    return data.payment_request;
  } catch (error) {
    console.error(error);
    return error;
  }
};

const payInvoice = async (
  adminKey: string,
  paymentRequest: string,
  extra: object,
) => {
  console.log(
    `payInvoice starting ... (adminKey: ${adminKey}, paymentRequest: ${paymentRequest}, extra: ${JSON.stringify(
      extra,
    )})`,
  );

  try {
    //const encodedExtra = JSON.stringify(extra);

    const response = await fetch(`${lnbiturl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': adminKey,
      },
      body: JSON.stringify({
        out: true,
        bolt11: paymentRequest,
        extra: extra, //encodedExtra,
      }),
    });

    if (!response.ok) {
      throw new Error(`Error paying invoice (status: ${response.status})`);
    }

    const data = await response.json();
    //console.log('payInvoice: data:', data);

    return data;
  } catch (error) {
    throw error;
  }
};

// TODO: This method needs checking!
const getWalletIdByUserId = async (adminKey: string, userId: string) => {
  console.log(
    `getWalletIdByUserId starting ... (adminKey: ${adminKey}, userId: ${userId})`,
  );

  try {
    const response = await fetch(
      `${lnbiturl}/api/v1/wallets?user_id=${userId}`,
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
    console.log('getWalletIdByUserId: data:', data);

    return data.id;
  } catch (error) {
    console.error(error);
    return null;
  }
};

async function topUpWallet(walletId: string, amount: number): Promise<void> {
  const accessToken = await getAccessToken(`${userName}`, `${password}`);

  const url = `${lnbiturl}/users/api/v1/topup`;
  const body = {
    amount: amount.toString(),
    id: walletId,
  };

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const responseData = await response.json();
    console.log('Wallet topped up successfully:', responseData);
  } catch (error) {
    console.error('Error topping up wallet:', error);
  }
}

// MIGRATED: scheduledTopup - Updated to use new service methods
// Note: Uses migrated getWallets, getUser functions with transitional approach
async function scheduledTopup() {
  // Using environment variables and migrated functions
  const allowancewallets = await getWallets(process.env.LNBITS_ADMINKEY as string, 'Allowance',);
  const allowanceValue = process.env.LNBITS_INITIAL_ALLOWANCE as string;
  const hostWalletId = process.env.LNBITS_HOST_WALLET_ID as string;
  const hostUserId = process.env.LNBITS_HOST_USER_ID as string;

  const host = getWalletById(hostUserId, hostWalletId);

  console.log('Wallets' , allowancewallets)

  if (allowancewallets) {
    allowancewallets.forEach(async wallet => {
     // Using migrated getUser function
     const User = await getUser(process.env.LNBITS_ADMINKEY as string, wallet.user);
  
     const extra = {
      from: wallet,
      to: host,
      tag: 'zap',
    }

    console.log('Extra:', extra);
    if(wallet.balance_msat > 0){
      const paymentRequest = await createInvoice(
        process.env.LNBITS_INKEY as string,
        hostWalletId, wallet.balance_msat/1000,
        `${User.displayName} Weekly Allowance cleared`,
        extra 
      ); 
      await payInvoice(wallet.adminkey , paymentRequest, extra)
     }
     // Using migrated topUpWallet function (already uses Users API)
     topUpWallet(wallet.id, parseInt(allowanceValue));
    });
  }
}

export {
  getWallets,
  createUser,
  getUser,
  updateUser,
  getUsers,
  getWalletName,
  getWalletById,
  getWalletBalance,
  getPayments,
  getWalletDetails,
  getWalletPayLinks,
  getUserWallets,
  getInvoicePayment,
  getPaymentsSince,
  createInvoice,
  createWallet,
  payInvoice,
  getWalletIdByUserId,
  topUpWallet,
  scheduledTopup,
};
