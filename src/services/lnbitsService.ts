// lnbitsService.ts

/// <reference path="../../src/types/global.d.ts" />

import dotenvFlow from 'dotenv-flow';

dotenvFlow.config({ path: './env' });
let globalWalletId: string | null = null;


//import dotenv from 'dotenv';
//dotenv.config();

const lnbiturl = process.env.LNBITS_NODE_URL as string;
const userName = process.env.LNBITS_USERNAME as string;
const password = process.env.LNBITS_PASSWORD as string;
//const adminkey = process.env.LNBITS_ADMINKEY as string; // This changes per wallet!

// Store token in localStorage (persists between page reloads)
let accessToken = null;

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

const getWallets = async (
  adminKey: string,
  filterByName?: string,
  filterById?: string,
): Promise<Wallet[] | null> => {
  console.log(
    `getWallets starting ... (adminKey: ${adminKey}, filterByName: ${filterByName}, filterById: ${filterById}))`,
  );

  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);
    const response = await fetch(`${lnbiturl}/api/v1/wallets`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
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

// Note: LNbits v1+ core API doesn't provide user listing/filtering with custom metadata.
// User management with custom metadata must be handled at the application layer.
// This function is deprecated and should be replaced with application-level user management.
const getUsers = async (
  adminKey: string,
  filterByExtra: { [key: string]: string } | null, // Pass the extra field as an object
): Promise<User[] | null> => {
  console.log(
    `getUsers starting ... (adminKey: ${adminKey}, filterByExtra: ${JSON.stringify(
      filterByExtra,
    )})`,
  );

  // LNbits v1+ core API doesn't support user listing with custom metadata
  // This functionality must be implemented at the application layer
  throw new Error(
    'getUsers is not supported by LNbits v1+ core API. Implement user management at application layer.',
  );
};

// Note: LNbits v1+ core API doesn't provide user creation with custom metadata.
// User creation must be handled at the application layer.
// This function is deprecated and should be replaced with application-level user management.
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

  // LNbits v1+ core API doesn't support user creation with custom metadata
  // This functionality must be implemented at the application layer
  throw new Error(
    'createUser is not supported by LNbits v1+ core API. Implement user management at application layer.',
  );
};

// Note: LNbits v1+ core API doesn't provide user details with custom metadata.
// User details must be handled at the application layer.
// This function is deprecated and should be replaced with application-level user management.
const getUser = async (
  adminKey: string,
  userId: string,
): Promise<User | null> => {
  console.log(
    `getUser starting ... (adminKey: ${adminKey}, userId: ${userId})`,
  );

  // LNbits v1+ core API doesn't support user details with custom metadata
  // This functionality must be implemented at the application layer
  throw new Error(
    'getUser is not supported by LNbits v1+ core API. Implement user management at application layer.',
  );
};

// Note: LNbits v1+ core API doesn't provide user updates with custom metadata.
// User updates must be handled at the application layer.
// This function is deprecated and should be replaced with application-level user management.
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

  // LNbits v1+ core API doesn't support user updates with custom metadata
  // This functionality must be implemented at the application layer
  throw new Error(
    'updateUser is not supported by LNbits v1+ core API. Implement user management at application layer.',
  );
};

// Note: LNbits v1+ core API uses /api/v1/wallet endpoint for wallet creation
// Wallet creation is now done through the core API, not UserManager
const createWallet = async (
  adminKey: string,
  userId: string,
  walletName: string,
): Promise<Wallet | null> => {
  console.log(
    `createWallet starting ... (adminKey: ${adminKey}, userId: ${userId}, walletName: ${walletName}))`,
  );

  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);

    // Prepare the request body
    const requestBody = {
      user_id: userId,
      wallet_name: walletName,
    };

    const response = await fetch(`${lnbiturl}/api/v1/wallet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Error creating wallet (status: ${response.status})`);
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

async function scheduledTopup() {
  const allowancewallets = await getWallets(process.env.LNBITS_ADMINKEY as string, 'Allowance',);
  const allowanceValue = process.env.LNBITS_INITIAL_ALLOWANCE as string;
  const hostWalletId = process.env.LNBITS_HOST_WALLET_ID as string;
  const hostUserId =process.env.LNBITS_HOST_USER_ID as string;

  const host = getWalletById(hostUserId, hostWalletId);

  console.log('Wallets' , allowancewallets)


  if (allowancewallets) {
    allowancewallets.forEach(async wallet => {
     const User = await getUser(process.env.LNBITS_ADMINKEY as string, wallet.user);
  
     const extra = {
      from: wallet,
      to: host,
      tag: 'zap',
    }

    console.log('Extra:', extra);
    if(wallet.balance_msat >0){

     const paymentRequest = await createInvoice(
      process.env.LNBITS_INKEY as string,
       hostWalletId, wallet.balance_msat/1000,
        `${User.displayName} Weekly Allowance cleared`,
        extra ); 
      await payInvoice(wallet.adminkey , paymentRequest, extra)}
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
