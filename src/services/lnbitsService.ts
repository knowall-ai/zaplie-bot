// lnbitsService.ts

import dotenvFlow from 'dotenv-flow';
import { isRecord } from '../utils/typeGuards';

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
      throw new Error('Failed to retrieve access token', { cause: error });
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
  admin?: string | null;
  name: string;
  user: string;
  adminkey?: string | null;
  inkey?: string | null;
  balance_msat?: number;
  deleted?: boolean | null;
}

// LNbits declares id, name and user required on every wallet route this file
// reads, so a missing one is a broken contract, not a wallet worth skipping.
// Dropping the row instead would hand a caller a short list it cannot tell
// from a complete one — and these lists drive balances and payments.
const REQUIRED_WALLET_FIELDS = ['id', 'name', 'user'] as const;

// The optional fields are only optional in their presence, not in their type.
// A row carrying deleted: "true" passes `deleted !== true` and stays visible,
// and a non-number balance_msat becomes NaN the moment a caller divides it by
// 1000 — so a wrong type here is validated, not certified by the cast below.
//
// `nullable` says whether LNbits may send an explicit null. It may for the
// descriptive strings, and a null `deleted` reads exactly as an absent one.
// It may not for balance_msat: null is not "no balance", and it would reach
// showMyBalanceCommand as a confident 0 sats for a wallet LNbits never said
// was empty.
const OPTIONAL_WALLET_FIELDS = {
  admin: { type: 'string', nullable: true },
  adminkey: { type: 'string', nullable: true },
  inkey: { type: 'string', nullable: true },
  balance_msat: { type: 'number', nullable: false },
  deleted: { type: 'boolean', nullable: true },
} as const;

const invalidWalletFields = (value: unknown): string[] => {
  // A row that is not an object at all is missing every required field.
  if (!isRecord(value))
    return REQUIRED_WALLET_FIELDS.map(field => `string ${field}`);

  const missing = REQUIRED_WALLET_FIELDS.filter(
    field => typeof value[field] !== 'string',
  ).map(field => `string ${field}`);

  const mistyped = Object.entries(OPTIONAL_WALLET_FIELDS)
    .filter(([field, spec]) => {
      const field_value = value[field];
      if (field_value === undefined) return false;
      if (field_value === null) return !spec.nullable;
      return typeof field_value !== spec.type;
    })
    .map(([field, spec]) => `${spec.type} ${field}`);

  return [...missing, ...mistyped];
};

/**
 * Validates an LNbits wallet-list payload before anything reads it.
 *
 * @param value - The parsed JSON body of a wallet route.
 * @param source - The calling function, used to name the failure.
 * @returns The payload, narrowed to validated wallet rows.
 * @throws When the payload is not an array, or a row is missing a required
 * string field.
 */
const toRawLnbitsWallets = (
  value: unknown,
  source: string,
): RawLnbitsWallet[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${source}: LNbits did not return a wallet array`);
  }
  value.forEach((wallet, index) => {
    const invalid = invalidWalletFields(wallet);
    if (invalid.length > 0) {
      throw new Error(
        `${source}: LNbits wallet at index ${index} is missing ${invalid.join(', ')}`,
      );
    }
  });
  return value;
};

const getWallets = async (
  adminKey: string,
  filterByName?: string,
  filterById?: string,
  // Failures reject rather than resolving with null: a null here used to be
  // indistinguishable from "this admin has no wallets".
): Promise<Wallet[]> => {
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
        // One lookup, not two: the second call fetched the same row again.
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

// LNbits pages the Users API (`limit`/`offset`; 10 per request by default on
// 1.6), so one request silently drops every account past the first page. Read
// page by page, ordered by id so page boundaries are stable (LNbits only adds
// ORDER BY when `sortby` is set). Stop once `total` is reached or, when the
// server sends no `total`, on an empty page: a short page may only be a
// server-side cap on `limit`, so `offset` advances by the rows received and
// only an empty page proves the end. Every record is checked before it is
// read, and every failure names the page it happened on.
export const USER_LIST_PAGE_SIZE = 100;
// Guard against a server that ignores `offset`: 10,000 accounts is far beyond
// any team this bot serves, so hitting it means something is wrong.
const USER_LIST_MAX_PAGES = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === 'string';

// One record of a user-list page. LNbits sends null for unset optional
// fields; anything else that is not a string is a malformed page, and a
// malformed page fails the whole read rather than yielding a half-built user.
const toRawUser = (
  entry: unknown,
  page: number,
  index: number,
): RawLnbitsUser => {
  const where = `page ${page + 1}, record ${index + 1}`;
  if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id === '') {
    throw new Error(`Error getting users: ${where} has no string id`);
  }
  const { username, email, external_id: externalId, extra } = entry;
  if (
    !isOptionalString(username) ||
    !isOptionalString(email) ||
    !isOptionalString(externalId)
  ) {
    const field = !isOptionalString(username)
      ? 'username'
      : !isOptionalString(email)
        ? 'email'
        : 'external_id';
    throw new Error(
      `Error getting users: ${where} (${entry.id}) has a non-string ${field}`,
    );
  }
  let profile: RawLnbitsUser['extra'] = null;
  if (extra !== undefined && extra !== null) {
    if (
      !isRecord(extra) ||
      !isOptionalString(extra.display_name) ||
      !isOptionalString(extra.picture)
    ) {
      throw new Error(
        `Error getting users: ${where} (${entry.id}) has an invalid extra`,
      );
    }
    profile = {
      display_name: extra.display_name ?? undefined,
      picture: extra.picture ?? undefined,
    };
  }
  return {
    id: entry.id,
    username: username ?? undefined,
    email: email ?? undefined,
    external_id: externalId ?? undefined,
    extra: profile,
  };
};

const getUsers = async (
  _adminKey: string, // Unused: auth is the superuser Bearer token via adminFetch
  filterByExtra: { [key: string]: string } | null,
): Promise<User[]> => {
  const aadObjectId = filterByExtra?.aadObjectId;
  const rawUsers: RawLnbitsUser[] = [];
  let previousFirstId: string | undefined;
  // The last `total` the server announced: an empty page that arrives before
  // it is reached is a partial list, not the end.
  let announcedTotal: number | undefined;
  // One request beyond the page cap: for a server that sends no `total` it
  // may be the empty page that proves the list complete.
  for (let page = 0; page <= USER_LIST_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      limit: String(USER_LIST_PAGE_SIZE),
      offset: String(rawUsers.length),
      sortby: 'id',
      direction: 'asc',
    });
    if (aadObjectId) {
      params.set('external_id', aadObjectId);
    }
    let response: Response;
    try {
      response = await adminFetch(`/users/api/v1/user?${params}`);
    } catch (error) {
      throw new Error(`Error getting users: page ${page + 1} request failed`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new Error(
        `Error getting users (status: ${response.status}, page ${page + 1})`,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(
        `Error getting users: page ${page + 1} is not valid JSON`,
        {
          cause: error,
        },
      );
    }
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new Error(
        `Error getting users: page ${page + 1} has no data array`,
      );
    }
    const pageUsers = body.data.map((entry, index) =>
      toRawUser(entry, page, index),
    );
    if (pageUsers.length === 0) {
      if (announcedTotal !== undefined && rawUsers.length < announcedTotal) {
        throw new Error(
          `Error getting users: page ${page + 1} came back empty after ${rawUsers.length} of the announced ${announcedTotal} accounts`,
        );
      }
      break;
    }
    if (page === USER_LIST_MAX_PAGES) {
      throw new Error(
        `Error getting users: more than ${rawUsers.length} accounts, refusing a partial list`,
      );
    }
    if (pageUsers[0].id === previousFirstId) {
      throw new Error(
        `Error getting users: LNbits ignored offset on page ${page + 1}`,
      );
    }
    previousFirstId = pageUsers[0].id;
    rawUsers.push(...pageUsers);
    // A present `total` that is not a count is an invalid response, not an
    // absent one: null must not turn into the empty-page rule.
    const total = body.total;
    if (
      total !== undefined &&
      (typeof total !== 'number' || !Number.isInteger(total) || total < 0)
    ) {
      throw new Error(
        `Error getting users: page ${page + 1} has an invalid total (${String(total)})`,
      );
    }
    if (typeof total === 'number') {
      announcedTotal = total;
      if (rawUsers.length >= total) {
        break;
      }
    }
  }
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
    throw error;
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
    throw error;
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
    throw error;
  }
};

// A stalled LNbits response must not hold a turn open forever: the leaderboard
// awaits every payment read, so one hung request would make the whole answer
// unavailable rather than slow. Node 24 (the declared runtime) has this API.
const LNBITS_REQUEST_TIMEOUT_MS = 30000;

// Payment listings are paged. These reads are exported, so validate the page
// before it reaches the query string: a fractional, negative or non-finite
// value would otherwise be pasted into the URL and answered with whatever
// LNbits makes of it, which is indistinguishable from a genuinely short page
// and so reads as "no more payments".
const MAX_PAGE_SIZE = 10000;

const requirePageBounds = (limit: number, offset: number): void => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new Error(
      `Invalid payments page limit: ${limit} (expected an integer 1-${MAX_PAGE_SIZE})`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(
      `Invalid payments page offset: ${offset} (expected an integer >= 0)`,
    );
  }
};

// `limit`/`offset` are the page LNbits applies to this wallet's payment list.
// `limit` defaults to the historical 100, but a caller that aggregates a
// wallet's whole history (see zapHistoryService) must page or it undercounts.
//
// This throws rather than returning null: a caller that cannot tell "no
// payments" from "the request failed" reports a zero total as fact, which is
// exactly the silent undercount #275 was about. Callers decide what a failure
// means for them.
const getPayments = async (
  inKey: string,
  limit = 100,
  offset = 0,
): Promise<Transaction[]> => {
  requirePageBounds(limit, offset);
  console.log(`getPayments starting ... (limit: ${limit}, offset: ${offset})`);

  const response = await fetch(
    `${lnbitsUrl()}/api/v1/payments?limit=${limit}&offset=${offset}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': inKey,
      },
      signal: AbortSignal.timeout(LNBITS_REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Error getting payments (status: ${response.status} ${response.statusText})`,
    );
  }

  return (await response.json()) as Transaction[];
};

// Raised when the instance has no /payments/all/paginated endpoint, or these
// credentials may not read it. Callers fall back to per-wallet paging.
class PaginatedPaymentsUnsupportedError extends Error {
  constructor(status: number) {
    super(`Paginated all-payments endpoint unavailable (status: ${status})`);
    this.name = 'PaginatedPaymentsUnsupportedError';
  }
}

// One page of every payment on the instance — the endpoint the portal reads
// (tabs/src/services/lnbits/payments.ts). One superuser-authenticated request
// per page replaces a request per wallet, and because the caller can page there
// is no hidden truncation: a truncated wallet would break the checking_id
// cross-reference and drop a zap with no error anywhere.
const getAllPaymentsPage = async (
  limit: number,
  offset: number,
): Promise<Transaction[]> => {
  requirePageBounds(limit, offset);
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sortby: 'time',
    direction: 'desc',
  });
  const response = await adminFetch(
    `/api/v1/payments/all/paginated?${query.toString()}`,
    { method: 'GET', signal: AbortSignal.timeout(LNBITS_REQUEST_TIMEOUT_MS) },
  );

  if ([401, 403, 404, 405].includes(response.status)) {
    throw new PaginatedPaymentsUnsupportedError(response.status);
  }

  if (!response.ok) {
    throw new Error(
      `Error getting all payments (status: ${response.status} ${response.statusText})`,
    );
  }

  const data = await response.json();

  // The paginated endpoint has shipped the array bare and wrapped under several
  // keys across LNbits versions, so accept each known shape.
  const payments = Array.isArray(data)
    ? data
    : (data?.data ?? data?.payments ?? data?.items);

  if (!Array.isArray(payments)) {
    throw new Error(
      `Unexpected payload from /api/v1/payments/all/paginated: ${JSON.stringify(data)}`,
    );
  }

  return payments as Transaction[];
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
    throw error;
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
    throw error;
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
    throw error;
  }
};

const getPaymentsSince = async (lnKey: string, timestamp: number) => {
  console.log(`getPaymentsSince starting ... (timestamp: ${timestamp})`);

  // Note that the timestamp is in seconds, not milliseconds.
  try {
    // Get walletId using the provided apiKey
    const walletId = await getWalletIdFromKey(lnKey);
    // Without this the id interpolates as "null" and LNbits answers a query
    // about no wallet at all, hiding the real failure (a bad key) behind an
    // empty payment list.
    if (typeof walletId !== 'string' || walletId === '') {
      throw new Error(
        'getPaymentsSince: no wallet could be resolved for the supplied key',
      );
    }

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
    throw error;
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

export {
  getAllPaymentsPage,
  PaginatedPaymentsUnsupportedError,
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
};
