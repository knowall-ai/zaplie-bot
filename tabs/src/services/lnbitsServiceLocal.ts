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

// Note: LNbits v1+ core API doesn't provide user listing/filtering with custom metadata.
// User management with custom metadata must be handled at the application layer.
// This function is deprecated and should be replaced with application-level user management.
const getUsers = async (
  adminKey: string,
  filterByExtra: { [key: string]: string } | null, // Pass the extra field as an object
): Promise<User[] | null> => {
  /*console.log(
    `getUsers starting ... (adminKey: ${adminKey}, filterByExtra: ${JSON.stringify(
      filterByExtra,
    )})`,
  );*/

  // LNbits v1+ core API doesn't support user listing with custom metadata
  // This functionality must be implemented at the application layer
  throw new Error(
    'getUsers is not supported by LNbits v1+ core API. Implement user management at application layer.',
  );
};

// Note: LNbits v1+ core API doesn't provide user details with custom metadata.
// User details must be handled at the application layer.
// This function is deprecated and should be replaced with application-level user management.
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

  // LNbits v1+ core API doesn't support user details with custom metadata
  // This functionality must be implemented at the application layer
  throw new Error(
    'getUser is not supported by LNbits v1+ core API. Implement user management at application layer.',
  );
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
    const response = await fetch(`${nodeUrl}/api/v1/wallets`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Error getting wallets (status: ${response.status})`,
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

    // Filter the payments to only include those since the provided timestamp
    const paymentsSince = data.filter(
      (payment: { time: number }) => payment.time > timestamp,
    );

    console.log("DATA2",paymentsSince);

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
};
