// lnbitsService.ts
//
// The bot's LNbits calls. Least privilege (docs/LNBITS_MIGRATION.adoc): every
// call carries a wallet key (X-Api-Key) - the sender's Allowance key from the
// people directory, or the Treasury admin key for automation rewards - except
// getAllPaymentsPage, which uses the optional zaplie.service ACL token. There
// is no username/password login and no admin Users API call; people and their
// wallets come from src/services/peopleDirectory.ts.

import dotenvFlow from 'dotenv-flow';
import { isRecord } from '../utils/typeGuards';

dotenvFlow.config({ path: './env' });

// Resolved per call, not at import: test suites import this module before the
// LNbits env is set, and a value captured at import would stay undefined.
// LNBITS_URL is the current name; LNBITS_NODE_URL is read for existing
// deployments.
const lnbitsUrl = (): string => {
  const value = process.env.LNBITS_URL || process.env.LNBITS_NODE_URL;
  if (!value) {
    throw new Error('LNBITS_URL is not set');
  }
  return value.replace(/\/+$/, '');
};

// LNbits API is documented here:
// https://demo.lnbits.com/docs/

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

// One page of every payment of the zaplie.service account - every Allowance
// wallet, the Fund and the Treasury - read with the optional ACL token
// (LNBITS_API_TOKEN). One request per page replaces a request per wallet.
// Without the token this throws PaginatedPaymentsUnsupportedError at once and
// the caller pages wallet by wallet with invoice keys instead.
const getAllPaymentsPage = async (
  limit: number,
  offset: number,
): Promise<Transaction[]> => {
  requirePageBounds(limit, offset);
  const token = process.env.LNBITS_API_TOKEN?.trim();
  if (!token) {
    throw new PaginatedPaymentsUnsupportedError(0);
  }
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sortby: 'time',
    direction: 'desc',
  });
  const response = await fetch(
    `${lnbitsUrl()}/api/v1/payments/all/paginated?${query.toString()}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(LNBITS_REQUEST_TIMEOUT_MS),
    },
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

// GET /api/v1/wallets is an account-level route that does not accept a
// wallet key, so this reads the key's own wallet from GET /api/v1/wallet.
// LNbits includes the id there for an admin key; for an invoice key it may
// not, and null is returned rather than a guess.
const getWalletIdFromKey = async (
  walletKey: string,
): Promise<string | null> => {
  console.log('getWalletIdFromKey starting ...');

  try {
    const response = await fetch(`${lnbitsUrl()}/api/v1/wallet`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': walletKey,
      },
    });

    if (!response.ok) {
      console.error(
        `Error getting wallet ID from Key response (status: ${response.status})`,
      );

      return null;
    }

    const data: unknown = await response.json();
    return isRecord(data) && typeof data.id === 'string' && data.id !== ''
      ? data.id
      : null;
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
      `${lnbitsUrl()}/api/v1/payments?wallet=${encodeURIComponent(walletId)}&limit=1`,
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

export {
  getAllPaymentsPage,
  PaginatedPaymentsUnsupportedError,
  getWalletBalance,
  getWalletIdFromKey,
  getPayments,
  getPaymentsSince,
  createInvoice,
  payInvoice,
};
