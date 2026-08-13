// lnbitsService.ts

import dotenvFlow from 'dotenv-flow';

dotenvFlow.config({ path: './env' });

//import dotenv from 'dotenv';
//dotenv.config();

// Resolved per call, not at import: test suites import this module before the
// LNbits env is set, and a value captured at import would stay undefined.
const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
};

const lnbitsUrl = () => requireEnv('LNBITS_NODE_URL');
const lnbitsCredentials = () => ({
  userName: requireEnv('LNBITS_USERNAME'),
  password: requireEnv('LNBITS_PASSWORD'),
});
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
  if (accessToken) {
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
  // Resolve required configuration before the request catch so a missing
  // variable keeps its actionable name instead of becoming a generic error.
  const nodeUrl = lnbitsUrl();

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
        //localStorage.setItem('accessToken', accessToken);
        console.log('Access token fetched and stored.');
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

interface RawLnbitsWallet {
  id: string;
  admin?: string;
  name: string;
  user: string;
  adminkey?: string;
  inkey?: string;
  balance_msat?: number;
  deleted?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isRawLnbitsWallet = (value: unknown): value is RawLnbitsWallet =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.user === 'string';

const toRawLnbitsWallets = (
  value: unknown,
  source: string,
): RawLnbitsWallet[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${source}: LNbits did not return a wallet array`);
  }
  if (!value.every(isRawLnbitsWallet)) {
    throw new Error(
      `${source}: LNbits returned a wallet without a string id, name, or user`,
    );
  }
  return value;
};

const getWallets = async (
  adminKey: string,
  filterByName?: string,
  filterById?: string,
): Promise<Wallet[] | null> => {
  console.log(
    `getWallets starting ... (filterByName: ${filterByName}, filterById: ${filterById}))`,
  );

  try {
    const { userName, password } = lnbitsCredentials();
    const accessToken = await getAccessToken(userName, password);
    const response = await fetch(`${lnbitsUrl()}/api/v1/wallets`, {
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

    const data = toRawLnbitsWallets(await response.json(), 'getWallets');

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
      filteredData.map(async rawWallet => {
        // See: https://github.com/lnbits/lnbits/issues/2690
        const walletDetails = await getWalletById(rawWallet.user, rawWallet.id);

        return {
          id: rawWallet.id,
          admin: rawWallet.admin,
          name: rawWallet.name,
          adminkey: rawWallet.adminkey,
          user: rawWallet.user,
          inkey: rawWallet.inkey,
          deleted: walletDetails?.deleted,
          balance_msat: walletDetails?.balance_msat,
        };
      }),
    );

    // Now remove the deleted wallets.
    walletData = walletData.filter(wallet => wallet.deleted != true);

    return walletData;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

const getUserWallets = async (
  adminKey: string,
  userId: string,
): Promise<Wallet[]> => {
  console.log(`getUserWallets starting ... (userId: ${userId})`);

  try {
    const { userName, password } = lnbitsCredentials();
    const accessToken = await getAccessToken(userName, password);
    const response = await fetch(
      `${lnbitsUrl()}/users/api/v1/user/${userId}/wallet`,
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

    const data = toRawLnbitsWallets(await response.json(), 'getUserWallets');

    // Map the wallets to match the Wallet interface
    const walletData: Wallet[] = data.map(wallet => ({
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

// LNbits v1+ wallet lookup authenticates with the server-side username/password
// flow. This one-argument wrapper avoids implying that an admin key is used.
const getUserWalletsByUserId = async (userId: string): Promise<Wallet[]> =>
  getUserWallets('', userId);

const adminFetch = async (
  path: string,
  init?: RequestInit,
): Promise<Response> => {
  const { userName, password } = lnbitsCredentials();
  const accessToken = await getAccessToken(userName, password);
  return fetch(`${lnbitsUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...init?.headers,
    },
  });
};

// The Azure AD object id is stored in the account's `external_id` (LNbits `extra`
// is a fixed profile schema); the Allowance/Private wallets are matched by name.
interface RawLnbitsUser {
  id: string;
  username?: string;
  email?: string;
  external_id?: string;
  extra?: { display_name?: string; picture?: string } | null;
}

// The user list omits display_name, so derive a readable name from the email
// local-part (e.g. "john.doe@acme.com" -> "John Doe").
const prettifyName = (email: string): string =>
  email
    .split('@')[0]
    .split('.')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const toUser = (
  raw: RawLnbitsUser,
  wallets: { allowanceWallet: Wallet | null; privateWallet: Wallet | null } = {
    allowanceWallet: null,
    privateWallet: null,
  },
): User => {
  const extra = raw.extra || {};
  return {
    id: raw.id,
    displayName:
      extra.display_name ||
      raw.username ||
      (raw.email ? prettifyName(raw.email) : '') ||
      raw.id,
    profileImg: extra.picture || '',
    aadObjectId: raw.external_id || '',
    email: raw.email || raw.username || '',
    allowanceWallet: wallets.allowanceWallet,
    privateWallet: wallets.privateWallet,
  };
};

const getUsers = async (
  _adminKey: string, // Unused: auth is the superuser Bearer token via adminFetch
  filterByExtra: { [key: string]: string } | null,
): Promise<User[]> => {
  const aadObjectId = filterByExtra?.aadObjectId;
  const query = aadObjectId
    ? `?external_id=${encodeURIComponent(aadObjectId)}`
    : '';
  const response = await adminFetch(`/users/api/v1/user${query}`);
  if (!response.ok) {
    throw new Error(`Error getting users (status: ${response.status})`);
  }
  const body = await response.json();
  const rawUsers: RawLnbitsUser[] = body.data;
  return rawUsers.map(raw => toUser(raw));
};

const createUser = async (
  _adminKey: string, // Unused: auth is the superuser Bearer token via adminFetch
  displayName: string,
  _walletName: string, // Unused: wallets are created separately via createWallet
  email: string,
  _legacyPassword: string, // Unused: passwords are not part of the v1.x Users API
  extra: { [key: string]: string },
): Promise<User> => {
  const response = await adminFetch('/users/api/v1/user', {
    method: 'POST',
    body: JSON.stringify({
      email: email || undefined,
      external_id: extra.aadObjectId,
      extra: { display_name: displayName, picture: extra.profileImg },
    }),
  });
  if (!response.ok) {
    throw new Error(`Error creating user (status: ${response.status})`);
  }
  return toUser(await response.json());
};

const getUser = async (
  adminKey: string,
  userId: string,
): Promise<User | null> => {
  if (!userId) {
    return null;
  }
  const response = await adminFetch(`/users/api/v1/user/${userId}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Error getting user (status: ${response.status})`);
  }
  const raw: RawLnbitsUser = await response.json();
  const wallets = await getUserWallets(adminKey, userId);
  const byName = (name: string) =>
    wallets.find(wallet => wallet.name === name) ?? null;
  return toUser(raw, {
    allowanceWallet: byName('Allowance'),
    privateWallet: byName('Private'),
  });
};

const createWallet = async (
  _adminKey: string,
  userId: string,
  walletName: string,
): Promise<Wallet> => {
  // Admin creates the wallet under the target user. POST /api/v1/wallet ignores
  // user_id and creates under the caller, so the per-user route is required.
  const response = await adminFetch(`/users/api/v1/user/${userId}/wallet`, {
    method: 'POST',
    body: JSON.stringify({ name: walletName }),
  });
  if (!response.ok) {
    throw new Error(`Error creating wallet (status: ${response.status})`);
  }
  const data = await response.json();
  const walletWithBalance = await getWalletById(data.user, data.id);
  return {
    id: data.id,
    admin: data.admin,
    name: data.name,
    adminkey: data.adminkey,
    user: data.user,
    inkey: data.inkey,
    // A freshly created wallet is empty and live; fall back to that if the
    // balance lookup can't resolve it yet (eventual consistency).
    balance_msat: walletWithBalance?.balance_msat ?? 0,
    deleted: walletWithBalance?.deleted ?? false,
  };
};

const getWalletDetails = async (inKey: string, walletId: string) => {
  console.log(`getWalletDetails starting ... (walletId: ${walletId}))`);
  try {
    const response = await fetch(`${lnbitsUrl()}/api/v1/wallets/${walletId}`, {
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
    return error;
  }
};

const getWalletBalance = async (inKey: string) => {
  console.log('getWalletBalance starting ...');
  try {
    const response = await fetch(`${lnbitsUrl()}/api/v1/wallet`, {
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
  console.log('getWalletName starting ...');

  try {
    const response = await fetch(`${lnbitsUrl()}/api/v1/wallet`, {
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
  console.log('getPayments starting ...');

  try {
    const response = await fetch(`${lnbitsUrl()}/api/v1/payments?limit=100`, {
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
  console.log(`getWalletPayLinks starting ... (walletId: ${walletId})`);

  try {
    const response = await fetch(
      `${lnbitsUrl()}/lnurlp/api/v1/links?all_wallets=false&wallet=${walletId}`,
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
    const { userName, password } = lnbitsCredentials();
    const accessToken = await getAccessToken(userName, password);
    const response = await fetch(
      `${lnbitsUrl()}/users/api/v1/user/${userId}/wallet`,
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

    const data = toRawLnbitsWallets(await response.json(), 'getWalletById');

    // Find the wallet with a matching inkey that are not deleted.
    const filteredWallets = data.filter(wallet => wallet.deleted !== true);
    const matchingWallet = filteredWallets.find(wallet => wallet.id === id);
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
  console.log('getWalletIdFromKey starting ...');

  try {
    const response = await fetch(`${lnbitsUrl()}/api/v1/wallets`, {
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

    const data = toRawLnbitsWallets(
      await response.json(),
      'getWalletIdFromKey',
    );

    // Find the wallet with a matching inkey
    const wallet = data.find(rawWallet => rawWallet.inkey === inKey);

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
    const response = await fetch(`${lnbitsUrl()}/api/v1/payments/${invoice}`, {
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
  console.log(`getPaymentsSince starting ... (timestamp: ${timestamp})`);

  // Note that the timestamp is in seconds, not milliseconds.
  try {
    // Get walletId using the provided apiKey
    const walletId = await getWalletIdFromKey(lnKey);

    const response = await fetch(
      `${lnbitsUrl()}/api/v1/payments?wallet=${walletId}&limit=1`,
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
    `createInvoice starting ... (recipientWalletId: ${recipientWalletId}, amount: ${amount})`,
  );

  try {
    const response = await fetch(`${lnbitsUrl()}/api/v1/payments`, {
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

    console.log('createInvoice: response status:', response.status);

    if (!response.ok) {
      throw new Error(`Error creating an invoice (status: ${response.status})`);
    }

    const data = await response.json();
    //console.log('createInvoice: data:', data);

    return data.payment_request;
  } catch (error) {
    console.error('createInvoice failed.', error);
    throw error;
  }
};

const payInvoice = async (
  adminKey: string,
  paymentRequest: string,
  extra: object,
) => {
  console.log('payInvoice starting ...');

  //const encodedExtra = JSON.stringify(extra);

  const response = await fetch(`${lnbitsUrl()}/api/v1/payments`, {
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
};

// TODO: This method needs checking!
const getWalletIdByUserId = async (adminKey: string, userId: string) => {
  console.log(`getWalletIdByUserId starting ... (userId: ${userId})`);

  try {
    const response = await fetch(
      `${lnbitsUrl()}/api/v1/wallets?user_id=${userId}`,
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

async function topUpWallet(walletId: string, amount: number): Promise<void> {
  const { userName, password } = lnbitsCredentials();
  const accessToken = await getAccessToken(userName, password);

  // /topup was removed by LNbits >= 1.0.0; balance top-ups now go through /balance.
  const url = `${lnbitsUrl()}/users/api/v1/balance`;
  const body = {
    id: walletId,
    amount,
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
  const allowancewallets = await getWallets(
    process.env.LNBITS_ADMINKEY as string,
    'Allowance',
  );
  const allowanceValue = process.env.LNBITS_INITIAL_ALLOWANCE as string;
  const hostWalletId = process.env.LNBITS_HOST_WALLET_ID as string;
  const hostUserId = process.env.LNBITS_HOST_USER_ID as string;

  const host = await getWalletById(hostUserId, hostWalletId);

  if (allowancewallets) {
    allowancewallets.forEach(async wallet => {
      const User = await getUser(
        process.env.LNBITS_ADMINKEY as string,
        wallet.user,
      );

      const extra = {
        from: wallet,
        to: host,
        tag: 'zap',
      };

      if (wallet.balance_msat > 0) {
        const paymentRequest = await createInvoice(
          process.env.LNBITS_INKEY as string,
          hostWalletId,
          wallet.balance_msat / 1000,
          `${User.displayName} Weekly Allowance cleared`,
          extra,
        );
        await payInvoice(wallet.adminkey, paymentRequest, extra);
      }
      topUpWallet(wallet.id, parseInt(allowanceValue));
    });
  }
}

export {
  getWallets,
  createUser,
  getUser,
  getUsers,
  getWalletName,
  getWalletById,
  getWalletBalance,
  getPayments,
  getWalletDetails,
  getWalletPayLinks,
  getUserWallets,
  getUserWalletsByUserId,
  getInvoicePayment,
  getPaymentsSince,
  createInvoice,
  createWallet,
  payInvoice,
  getWalletIdByUserId,
  topUpWallet,
  scheduledTopup,
};
