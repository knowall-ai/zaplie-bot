// lnbitsService.ts

// LNBits API is documented here:
// https://demo.lnbits.com/docs/

const userName = process.env.REACT_APP_LNBITS_USERNAME;
const password = process.env.REACT_APP_LNBITS_PASSWORD;
const nodeUrl = process.env.REACT_APP_LNBITS_NODE_URL;

// Store token in localStorage (persists between page reloads)
let accessToken = localStorage.getItem('accessToken');
let accessTokenPromise: Promise<string> | null = null; // To cache the pending token request

export async function getAccessToken(
  username: string,
  password: string,
): Promise<string> {
  console.log('=== getAccessToken DEBUG ===');
  console.log('Username:', username);
  console.log('Password:', password);
  console.log('===========================');

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
      const response = await fetch(`${nodeUrl}/api/v1/auth`, {
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
        localStorage.setItem('accessToken', accessToken);
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

const getWallets = async (
  filterByName?: string,
  filterById?: string,
): Promise<Wallet[] | null> => {
  /*console.log(
    `getWallets starting ... (filterByName: ${filterByName}, filterById: ${filterById}))`,
  );*/

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
    console.error(error);
    throw error;
  }
};

const getWalletDetails = async (inKey: string, walletId: string) => {
  /*console.log(
    `getWalletDetails starting ... (inKey: ${inKey}, walletId: ${walletId}))`,
  );*/

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
    console.error(error);
    throw error;
  }
};

const getWalletBalance = async (inKey: string) => {
  //console.log(`getWalletBalance starting ... (inKey: ${inKey})`);

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
    console.error(error);
    throw error;
  }
};

const getUserWallets = async (
  adminKey: string,
  userId: string,
): Promise<Wallet[] | null> => {
  /*console.log(
    `getUserWallets starting ... (adminKey: ${adminKey}, userId: ${userId})`,
  );*/

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

    // Map the wallets to match the Wallet interface
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

    return filteredWallets;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

// Migrated to use LNbits v1+ core API
// Gets all users from /users/api/v1/user endpoint
const getUsers = async (
  adminKey: string,
  filterByExtra: { [key: string]: string } | null, // Pass the extra field as an object
): Promise<User[] | null> => {
  console.log('=== getUsers ===');
  console.log('Fetching users from /users/api/v1/user');

  try {
    // Get all users directly from the Users API
    const rawUsers = await getAllUsersFromAPI();

    if (!rawUsers || rawUsers.length === 0) {
      console.log('No users found');
      return [];
    }

    console.log(`Found ${rawUsers.length} users`);

    // Debug: Log first user to see available fields
    if (rawUsers.length > 0) {
      console.log('=== SAMPLE RAW USER FROM API ===');
      console.log('Sample user data:', rawUsers[0]);
      console.log('Available fields:', Object.keys(rawUsers[0]));
    }

    // Map the raw user data to User objects
    // Note: Wallets are NOT fetched here - use separate functions to get wallets when needed
    const users: User[] = rawUsers.map((user: any) => {
      // Try to get a friendly display name from various fields
      let displayName = user.username || user.id;

      // If username is an email, extract the name part
      if (displayName.includes('@')) {
        displayName = displayName.split('@')[0].replace('.', ' ');
        // Capitalize first letter of each word
        displayName = displayName.split(' ').map((word: string) =>
          word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');
      }

      return {
        id: user.id,
        displayName: displayName,
        profileImg: user.extra?.profileImg || '', // Get from extra metadata if available
        aadObjectId: user.extra?.aadObjectId || '', // Get from extra metadata if available
        email: user.email || user.extra?.email || user.username || '', // Get from user object or extra metadata
        type: (user.extra?.type as UserType) || 'Teammate' as UserType, // Default type
        privateWallet: null, // Wallets should be fetched separately when needed
        allowanceWallet: null, // Wallets should be fetched separately when needed
      };
    });

    // Apply filterByExtra if provided
    if (filterByExtra && Object.keys(filterByExtra).length > 0) {
      // Filter users based on extra metadata
      const filteredUsers = users.filter(user => {
        const userRaw = rawUsers.find((u: any) => u.id === user.id);
        if (!userRaw || !userRaw.extra) return false;

        return Object.keys(filterByExtra).every(
          key => userRaw.extra[key] === filterByExtra[key]
        );
      });
      console.log(`Filtered to ${filteredUsers.length} users based on extra metadata`);
      return filteredUsers;
    }

    console.log('Returning all users');
    return users;
  } catch (error) {
    console.error('Error fetching users:', error);
    throw error;
  }
};

// Migrated to use LNbits v1+ core API
// Gets a single user by fetching their wallets and constructing a User object
const getUser = async (
  adminKey: string,
  userId: string,
): Promise<User | null> => {
  /*console.log(
    `getUser starting ... (adminKey: ${adminKey}, userId: ${userId})`,
  );*/

  if (!userId || userId === '' || userId === 'undefined') {
    return null;
  }

  try {
    // Get user's wallets using core API
    const userWallets = await getUserWallets(adminKey, userId);

    if (!userWallets || userWallets.length === 0) {
      return null;
    }

    // Find private and allowance wallets
    const privateWallet = userWallets.find(w =>
      w.name.toLowerCase().includes('private')
    ) || null;

    const allowanceWallet = userWallets.find(w =>
      w.name.toLowerCase().includes('allowance')
    ) || null;

    // Extract display name from wallet name
    let displayName = userId;
    if (privateWallet) {
      // Try to extract name from private wallet (format: "UserName - Private")
      const nameParts = privateWallet.name.split('-');
      if (nameParts.length > 1) {
        displayName = nameParts[0].trim();
      }
    } else if (userWallets.length > 0) {
      // Use first wallet name
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
    console.error(`Error fetching user ${userId}:`, error);
    throw error;
  }
};

const getWalletName = async (inKey: string) => {
  //console.log(`getWalletName starting ... (inKey: ${inKey})`);

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
    console.error(error);
    throw error;
  }
};

const getWalletPayments = async (inKey: string) => {
  //console.log(`getWalletPayments starting ... (inKey: ${inKey})`);

  try {
    const response = await fetch(`${nodeUrl}/api/v1/payments?limit=100`, {
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
  /*console.log(
    `getWalletPayLinks starting ... (inKey: ${inKey}, walletId: ${walletId})`,
  );*/

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
      console.error(
        `Error getting paylinks for wallet (status: ${response.status})`,
      );
      return null;
    }

    const data = await response.json();

    return data;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

const getWalletById = async (
  userId: string,
  id: string,
): Promise<Wallet | null> => {
  //console.log(`getWalletById starting ... (userId: ${userId}, id: ${id})`);

  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);

    const response = await fetch(
      `${nodeUrl}/users/api/v1/user/${userId}/wallet`,
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
      console.warn(`Wallet with ID ${id} not found.`);
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
const getWalletId = async (inKey: string) => {
  //console.log(`getWalletId starting ... (inKey: ${inKey})`);

  try {
    const response = await fetch(`${nodeUrl}/api/v1/wallets`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': inKey,
      },
    });

    if (!response.ok) {
      console.error(`Error getting wallet ID (status: ${response.status})`);
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
    throw error;
  }
};

const getInvoicePayment = async (lnKey: string, invoice: string) => {
  /*console.log(
    `getInvoicePayment starting ... (inKey: ${lnKey}, invoice: ${invoice})`,
  );*/

  try {
    const response = await fetch(`${nodeUrl}/api/v1/payments/${invoice}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': lnKey,
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
    throw error;
  }
};

//Akash Performance Test - Migrated to use core API
const getAllWallets = async (lnKey: string) => {

  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);

    console.log('=== getAllWallets DEBUG ===');
    console.log('Fetching from:', `${nodeUrl}/api/v1/wallets`);
    console.log('Access Token:', accessToken);
    console.log('===========================');

    const response = await fetch(`${nodeUrl}/api/v1/wallets`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      console.error('Response status:', response.status);
      console.error('Response statusText:', response.statusText);
      throw new Error(
        `Error getting wallets (status: ${response.status})`,
      );
    }

    const data: Wallet[] = await response.json();

    console.log('All Wallets returned:', data.length);
    console.log('All Wallets: ', data);

    // Map the wallets to match the Wallet interface
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

    console.log('Filtered wallets count:', filteredWallets.length);
    return filteredWallets;
  } catch (error) {
    console.error('Error in getAllWallets:', error);
    throw error;
  }
};

const getWalletTransactionsSince = async (
  inKey: string,
  timestamp: number,
  filterByExtra: { [key: string]: string } | null, // Pass the extra field as an object
): Promise<Transaction[]> => {
  /*console.log(
    `getWalletTransactionsSince starting ... (lnKey: ${inKey}, timestamp: ${timestamp}, filterByExtra: ${JSON.stringify(
      filterByExtra,
    )}`,
  );*/

  // Note that the timestamp is in seconds, not milliseconds.
  try {
    // Get walletId using the provided apiKey
    //const walletId = await getWalletId(lnKey);
    //const encodedExtra = JSON.stringify(filterByExtra);

    const response = await fetch(
      //`/api/v1/payments?limit=100&extra=${encodedExtra}`, // This approach doesn't work on this endpoint for some reason, we need to filter afterwards.
      `${nodeUrl}/api/v1/payments?limit=100`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': inKey,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Error getting payments since ${timestamp} (status: ${response.status})`,
      );
    }

    const data = await response.json();

    console.log("DATA",data);

    // Show all payments (timestamp filter removed)
    const paymentsSince = data;

    console.log("DATA2 (all payments, no timestamp filter)",paymentsSince);

    // Further filter by the `extra` field (if provided)
    const filteredPayments = filterByExtra
      ? paymentsSince.filter((payment: any) => {
          // Check if the payment's extra field matches the filterByExtra object
          const paymentExtra = payment.extra || {};
          return Object.keys(filterByExtra).every(
            key => paymentExtra[key] === filterByExtra[key],
          );
        })
      : paymentsSince;

      console.log("DATA2",filteredPayments);

    // Map the payments to match the Zap interface
    const transactionData: Transaction[] = filteredPayments.map(
      (transaction: any) => ({
        checking_id: transaction.id,
        bolt11: transaction.bolt11,
        //from: transaction.extra?.from?.id || null, // This should be in "extra" field
        //to: transaction.extra?.to?.id || null, // This should be in "extra" field
        memo: transaction.memo,
        amount: transaction.amount,
        wallet_id: transaction.wallet_id,
        time: transaction.time,
        extra: transaction.extra,
      }),
    );

    //console.log('Transactions:', transactionData);

    return transactionData;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

// TODO: This method needs checking!
const createInvoice = async (
  lnKey: string,
  recipientWalletId: string,
  amount: number,
  memo: string,
  // extra: object,
) => {
  console
    .log
    // `createInvoice starting ... (lnKey: ${lnKey}, recipientWalletId: ${recipientWalletId}, amount: ${amount}, memo: ${memo}, extra: ${extra})`,
    ();

  try {
    const response = await fetch(`${nodeUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': lnKey,
      },
      body: JSON.stringify({
        out: false,
        amount: amount,
        memo: memo,
        // extra: extra,
      }),
    });

    if (!response.ok) {
      throw new Error(`Error creating an invoice (status: ${response.status})`);
    }

    const data = await response.json();

    return data.payment_request;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

const payInvoice = async (adminKey: string, paymentRequest: string) => {
  /*console.log(
    `payInvoice starting ... (adminKey: ${adminKey}, paymentRequest: ${paymentRequest})`,
  );*/

  try {
    const response = await fetch(`${nodeUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': adminKey,
      },
      body: JSON.stringify({
        out: true,
        bolt11: paymentRequest,
      }),
    });

    if (!response.ok) {
      throw new Error(`Error paying invoice (status: ${response.status})`);
    }

    const data = await response.json();

    return data;
  } catch (error) {
    throw error;
  }
};

const createWallet = async (
  apiKey: string,
  objectID: string,
  displayName: string,
) => {
  /*console.log(
    `createWallet starting ... (apiKey: ${apiKey}, objectID: ${objectID}, displayName: ${displayName})`,
  );*/

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
    console.error(error);
    throw error;
  }
};

// TODO: This method needs checking!
const getWalletIdByUserId = async (adminKey: string, userId: string) => {
  /*console.log(
    `getWalletIdByUserId starting ... (adminKey: ${adminKey}, userId: ${userId})`,
  );*/

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
    console.error(error);
    return null;
  }
};

const getNostrRewards = async (
  adminKey: string,
  stallId: string,
): Promise<Reward[]> => {
  /*console.log(
    `getNostrRewards starting ... (adminKey: ${adminKey}, stallId: ${stallId})`,
  );*/
  try {
    const response = await fetch(
      `${nodeUrl}/nostrmarket/api/v1/stall/product/${stallId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': adminKey,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Error getting products (status: ${response.status})`);
    }

    // Check if the response is JSON
    const contentType = response.headers.get('content-type');
    console.log('Content-Type:', contentType);

    if (contentType && contentType.includes('application/json')) {
      const data: Reward[] = await response.json();
      console.log('Products:', data);
      return data;
    } else {
      const text = await response.text(); // Capture non-JSON responses
      console.log('Non-JSON response:', text);
      throw new Error(`Expected JSON, but got: ${text}`);
    }
  } catch (error) {
    console.error('Error fetching rewards:', error);
    throw error;
  }
};

// Migrated from UserManager to core API - Uses /api/v1/payments instead of /usermanager/api/v1/transactions
const getUserWalletTransactions = async (
  walletId: string,
  apiKey: string,
  filterByExtra: { [key: string]: string } | null, // Pass the extra field as an object
): Promise<Transaction[]> => {
  /*console.log(
    `getNostrRewards starting ... (walletId: ${walletId}, apiKey: ${apiKey}, filterByExtra: ${JSON.stringify(
      filterByExtra,
    )}`,
  );*/

  try {
    // Use core API /api/v1/payments with wallet filter instead of deprecated /usermanager/api/v1/transactions
    const response = await fetch(
      `${nodeUrl}/api/v1/payments?wallet=${walletId}&limit=100`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Api-Key': apiKey,
        },
      },
    );

    if (!response.ok) {
      const errorMessage = `Failed to fetch transactions for wallet ${walletId}: ${response.status} - ${response.statusText}`;
      console.error(errorMessage);
      throw new Error(errorMessage);
    }

    const data = await response.json();

    // Further filter by the `extra` field (if provided)
    const filteredPayments = filterByExtra
      ? data.filter((payment: any) => {
          // Check if the payment's extra field matches the filterByExtra object
          const paymentExtra = payment.extra || {};
          return Object.keys(filterByExtra).every(
            key => paymentExtra[key] === filterByExtra[key],
          );
        })
      : data;

    /*console.log(
      `Transactions fetched for wallet: ${walletId}`,
      filteredPayments,
    );*/ // Log fetched data
    return filteredPayments; // Assuming data is an array of transactions
  } catch (error) {
    console.error(`Error fetching transactions for wallet ${walletId}:`, error);
    throw error; // Re-throw the error to handle it in the parent function
  }
};

const getAllowance = async (
  adminKey: string,
  userId: string,
): Promise<Allowance | null> => {
  console.log(
    `getNostrRewards starting ... (adminKey: ${adminKey}, stallId: ${userId})`,
  );
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
    console.error(`Error fetching allowances for ${userId}:`, error);
    throw error; // Re-throw the error to handle it in the parent function
  }
};

// NEW: Get all payments from all users across the entire system
const getAllPayments = async (
  limit: number = 1000,
  offset: number = 0,
  sortby: string = 'time',
  direction: string = 'desc'
): Promise<Transaction[]> => {
  console.log('=== getAllPayments DEBUG ===');
  console.log('Fetching from:', `${nodeUrl}/api/v1/payments/all/paginated`);
  console.log('Parameters:', { limit, offset, sortby, direction });

  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);

    const url = new URL(`${nodeUrl}/api/v1/payments/all/paginated`);
    url.searchParams.append('limit', limit.toString());
    url.searchParams.append('offset', offset.toString());
    url.searchParams.append('sortby', sortby);
    url.searchParams.append('direction', direction);

    console.log('Full URL:', url.toString());

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      console.error('Response status:', response.status);
      console.error('Response statusText:', response.statusText);
      throw new Error(
        `Error getting all payments (status: ${response.status})`,
      );
    }

    const data = await response.json();
    console.log('Raw response data:', data);
    console.log('Data type:', typeof data);
    console.log('Is array:', Array.isArray(data));

    // The API might return an object with a 'data' or 'payments' property
    let payments = data;

    // Check if data is wrapped in an object
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.data && Array.isArray(data.data)) {
        payments = data.data;
      } else if (data.payments && Array.isArray(data.payments)) {
        payments = data.payments;
      } else if (data.items && Array.isArray(data.items)) {
        payments = data.items;
      }
    }

    console.log('Total payments retrieved:', payments?.length || 0);
    console.log('Sample payment:', payments?.[0]);
    console.log('===========================');

    return Array.isArray(payments) ? payments : [];
  } catch (error) {
    console.error('Error in getAllPayments:', error);
    throw error;
  }
};

// NEW: Get all users from /users/api/v1/user endpoint
const getAllUsersFromAPI = async (): Promise<any[]> => {
  console.log('=== getAllUsersFromAPI ===');
  console.log('Fetching from:', `${nodeUrl}/users/api/v1/user`);

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
      console.error('Response status:', response.status);
      console.error('Response statusText:', response.statusText);
      throw new Error(
        `Error getting all users (status: ${response.status})`,
      );
    }

    const responseData = await response.json();
    console.log('Total users retrieved:', responseData?.data?.length || 0);
    console.log('All Users:', responseData);
    console.log('===========================');

    // Extract the users array from the response
    const users = responseData?.data || [];
    return Array.isArray(users) ? users : [];
  } catch (error) {
    console.error('Error in getAllUsersFromAPI:', error);
    throw error;
  }
};

// NEW: Get wallets paginated for a specific user
const getWalletsPaginated = async (
  userId: string,
  limit: number = 100,
  offset: number = 0
): Promise<Wallet[]> => {
  console.log('=== getWalletsPaginated ===');
  console.log('>>> Requested User ID:', userId);
  console.log('Fetching from:', `${nodeUrl}/api/v1/wallet/paginated`);
  console.log('Parameters:', { limit, offset, user_id: userId });

  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);

    const url = new URL(`${nodeUrl}/api/v1/wallet/paginated`);
    url.searchParams.append('limit', limit.toString());
    url.searchParams.append('offset', offset.toString());
    url.searchParams.append('user_id', userId);

    console.log('>>> Full URL with params:', url.toString());

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      console.error('Response status:', response.status);
      console.error('Response statusText:', response);
      throw new Error(
        `Error getting wallets for user ${userId} (status: ${response.status})`,
      );
    }

    const responseData = await response.json();
    console.log(`>>> Raw response for user ${userId}:`, responseData);

    // Extract the wallets array from the response (API returns {data: [...], total: X})
    const wallets = responseData?.data || [];
    console.log(`>>> Extracted ${wallets.length} wallets from response`);

    // DEBUG: Show the wallet.user field for each wallet to verify they match the requested userId
    console.log(`>>> WALLET USER IDs FOR REQUESTED USER ${userId}:`);
    wallets.forEach((wallet: any, index: number) => {
      console.log(`  Wallet ${index + 1}: ID=${wallet.id}, Name="${wallet.name}", User ID=${wallet.user}, Matches=${wallet.user === userId ? '✓' : '✗'}`);
    });

    // Map ALL fields from the API response to match the Wallet interface
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

    // Filter out deleted wallets
    const filteredWallets = walletData.filter(
      wallet => wallet.deleted !== true,
    );

    console.log(`>>> Filtered wallets count for user ${userId}:`, filteredWallets.length);
    console.log(`>>> Wallet IDs: [${filteredWallets.map(w => w.id).join(', ')}]`);
    console.log('===========================');

    return filteredWallets;
  } catch (error) {
    console.error(`Error in getWalletsPaginated for user ${userId}:`, error);
    throw error;
  }
};

export {
  getUser,
  getUsers,
  getWallets,
  getWalletName,
  getWalletId,
  getWalletBalance,
  getWalletPayments,
  getWalletDetails,
  getWalletPayLinks,
  getInvoicePayment,
  getWalletTransactionsSince,
  createInvoice,
  createWallet,
  payInvoice,
  getWalletIdByUserId,
  getUserWallets,
  getNostrRewards,
  getUserWalletTransactions,
  getAllowance,
  getAllWallets,
  getAllPayments,
  getAllUsersFromAPI,
  getWalletsPaginated,
};
