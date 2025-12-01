import { console } from 'inspector';
import { getCredentials } from '../services/utils';
import { HttpRequest } from  "@azure/functions"

/// <reference path= "../types/global.d.ts" />

; // Import HttpRequest from the appropriate library

const { password, siteUrl, username, adminKey } = getCredentials({} as HttpRequest);
let lnbiturl: string | null = null;

// Function to set the lnbiturl based on the request
export function setLnbitUrl(req: HttpRequest) {
    const { siteUrl} = getCredentials(req);
    lnbiturl = siteUrl;   
}


// Load the environment variables from the .env file

let globalWalletId: string | null = null;

// Store token in localStorage (persists between page reloads)
let accessToken: string | null = null;

// LNBits API is documented here:
// https://demo.lnbits.com/docs/

// Store token in localStorage (persists between page reloads)
let accessTokenPromise: Promise<string> | null = null; // To cache the pending token request

export async function getAccessToken(
  req: HttpRequest,
  username: string,
  password: string,
): Promise<string> {
  if (!lnbiturl) {
    setLnbitUrl(req);
  }

  if (accessToken) {
    return accessToken;
  } else {
    console.log('No cached access token found');
  }
  if (accessTokenPromise) {
    console.log('Returning ongoing access token request');
    return accessTokenPromise;
  }
  console.log('No cached access token found, requesting a new one');
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
      if (!response.ok) {
        throw new Error(
          `Error creating access token (status: ${response.status}): ${response.statusText}`,
        );
      }
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Response is not in JSON format');
      }
      const data = await response.json() as { access_token: string };
      if (!data || !data.access_token) {
        throw new Error('Access token is missing in the response');
      }
      accessToken = data.access_token;
      return accessToken;
    } catch (error) {
      console.error('Error in getAccessToken:', error);
      throw new Error('Failed to retrieve access token');
    } finally {
      accessTokenPromise = null;
    }
  })();
  return accessTokenPromise;
}

const getWallets = async (
  req: HttpRequest,
  adminKey: string,
  filterByName?: string,
  filterById?: string,
): Promise<Wallet[] | null> => {
  console.log(
    `getWallets starting ... (adminKey: ${adminKey}, filterByName: ${filterByName}, filterById: ${filterById}))`,
  );

  try {
    const accessToken = await getAccessToken(req, `${username}`, `${password}`);
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

    const data = await response.json() as Wallet[];

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

    // Map the wallets to match the Wallet interface
    let walletData: Wallet[] = await Promise.all(
      data.map(async (filteredData: any) => ({
        id: filteredData.id,
        admin: filteredData.admin,
        name: filteredData.name,
        adminkey: filteredData.adminkey,
        user: filteredData.user,
        inkey: filteredData.inkey,
        // See: https://github.com/lnbits/lnbits/issues/2690
        deleted: (
          await getWalletById(filteredData.user, filteredData.id)
        )?.deleted ?? false,
        balance_msat: (
          await getWalletById( filteredData.user, filteredData.id)
        )?.balance_msat ?? 0,
      })),
    );

    // Now remove the deleted wallets.
    walletData = walletData.filter(wallet => wallet.deleted != true);

    return walletData;
  } catch (error) {
    console.error(error);
    return null;
  }
};

const getUserWallets = async (
  req: HttpRequest,
  adminKey: string,
  userId: string,
): Promise<Wallet[] | null> => {
  if (!lnbiturl) {
    setLnbitUrl(req);
  }
  console.log(
    `getUserWallets starting ... (adminKey: ${adminKey}, userId: ${userId})`,
  );

  try {
    const accessToken = await getAccessToken(req,`${username}`, `${password}`);
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

    const data: Wallet[] = await response.json() as Wallet[];

    // Map the wallets to match the Wallet interface
    let walletData: Wallet[] = data.map((wallet: any) => ({
      id: wallet.id,
      admin: '', // TODO: To be implemented. Ref: https://t.me/lnbits/90188
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
  req: HttpRequest,
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
  req: HttpRequest,
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




// Note: LNbits v1+ core API doesn't provide user updates with custom metadata.
// User updates must be handled at the application layer.
// This function is deprecated and should be replaced with application-level user management.
const updateUser = async (
  req: HttpRequest,
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
  req: HttpRequest,
  adminKey: string,
  userId: string,
  walletName: string,
): Promise<Wallet | null> => {
  console.log(
    `createWallet starting ... (adminKey: ${adminKey}, userId: ${userId}, walletName: ${walletName}))`,
  );

  try {
    const accessToken = await getAccessToken(req, `${username}`, `${password}`);

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

    const data = await response.json() as any;

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
      balance_msat: walletWithBalance?.balance_msat ?? 0,
      deleted: walletWithBalance?.deleted ?? false,
    };

    console.log('createWallet data:', walletData);

    return walletData;
  } catch (error) {
    console.error(error);
    return null;
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

    const data = await response.json() as any;

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

    const data = await response.json() as any;

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
const req= {} as HttpRequest;
  try {
    const accessToken = await getAccessToken(req,`${username}`, `${password}`);
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

    const data = await response.json() as Wallet[];

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

    const data = await response.json() as Wallet[];

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

    const data = await response.json() as any;

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

const createInvoice = async (
  req: HttpRequest,
  lnKey: string,
  recipientWalletId: string,
  amount: number,
  memo: string,
  extra: object,
) => {
  console.log(
    `createInvoice starting ... (lnKey: ${lnKey}, recipientWalletId: ${recipientWalletId}, amount: ${amount}, memo: ${memo}, extra: ${extra})`,
  );
  if (!lnbiturl) {
    console.log('Setting lnbiturl ...');
    setLnbitUrl(req);
}
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
      unit: 'sat',
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
  req: HttpRequest,
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

    const data = await response.json() as any;
    console.log('getWalletIdByUserId: data:', data);

    return data.id;
  } catch (error) {
    console.error(error);
    return null;
  }
};

// Note: LNbits v1+ core API doesn't provide user details with custom metadata.
// User details must be handled at the application layer.
// This function is deprecated and should be replaced with application-level user management.
const getUser = async(req: HttpRequest, userId: string, adminKey: string): Promise<any> =>{

  console.log(`getUser starting ... (adminKey: ${adminKey}, userId: ${userId})`);

  // LNbits v1+ core API doesn't support user details with custom metadata
  // This functionality must be implemented at the application layer
  throw new Error(
    'getUser is not supported by LNbits v1+ core API. Implement user management at application layer.',
  );
}

async function topUpWallet(walletId: string, amount: number,  req: HttpRequest): Promise<void> {
  const accessToken = await getAccessToken(req,`${username}`, `${password}`);

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

export {
  getUser,
  getWallets,
  createUser,
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
  createWallet,
  payInvoice,
  getWalletIdByUserId,
  topUpWallet,
  createInvoice,
};
