import { logger } from '../../utils/logger';
import { getAccessToken } from './auth';
import { nodeUrl, password, userName } from './config';

// Shape returned by the LNbits payments API, before it is mapped to Transaction.
// Older LNbits builds name the identifier payment_hash or id instead of checking_id.
interface RawPayment extends Omit<Transaction, 'checking_id'> {
  checking_id?: string;
  payment_hash?: string;
  id?: string;
}

const matchesExtra = (
  payment: RawPayment,
  filterByExtra: { [key: string]: string },
): boolean => {
  const paymentExtra = payment.extra ?? {};
  return Object.keys(filterByExtra).every(
    key => paymentExtra[key] === filterByExtra[key],
  );
};

const getWalletPayments = async (inKey: string): Promise<RawPayment[]> => {
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

  return response.json();
};

const getInvoicePayment = async (lnKey: string, invoice: string) => {
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
    logger.error(error);
    throw error;
  }
};

const getWalletTransactionsSince = async (
  inKey: string,
  timestamp: number,
  filterByExtra: { [key: string]: string } | null, // Pass the extra field as an object
): Promise<Transaction[]> => {
  // Note that the timestamp is in seconds, not milliseconds.
  try {
    // The endpoint ignores an `extra` query parameter, so filtering happens below.
    const response = await fetch(
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

    const data: RawPayment[] = await response.json();

    const filteredPayments = filterByExtra
      ? data.filter(payment => matchesExtra(payment, filterByExtra))
      : data;

    return filteredPayments.map(transaction => {
      const checkingId =
        transaction.checking_id || transaction.payment_hash || transaction.id;
      if (!checkingId) {
        // FeedList keys and de-duplicates on this, so a missing id corrupts the feed silently.
        throw new Error(
          `Payment has no checking_id, payment_hash or id: ${JSON.stringify(transaction)}`,
        );
      }

      return {
        checking_id: checkingId,
        bolt11: transaction.bolt11,
        memo: transaction.memo,
        amount: transaction.amount,
        wallet_id: transaction.wallet_id,
        time: transaction.time,
        extra: transaction.extra,
        pending: transaction.pending,
        fee: transaction.fee,
      };
    });
  } catch (error) {
    logger.error(error);
    throw error;
  }
};

const getUserWalletTransactions = async (
  walletId: string,
  apiKey: string,
  filterByExtra: { [key: string]: string } | null, // Pass the extra field as an object
): Promise<RawPayment[]> => {
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
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }

    const data: RawPayment[] = await response.json();

    return filterByExtra
      ? data.filter(payment => matchesExtra(payment, filterByExtra))
      : data;
  } catch (error) {
    logger.error(`Error fetching transactions for wallet ${walletId}:`, error);
    throw error;
  }
};

const getAllPayments = async (
  limit: number = 1000,
  offset: number = 0,
  sortby: string = 'time',
  direction: string = 'desc',
): Promise<Transaction[]> => {
  try {
    const accessToken = await getAccessToken(`${userName}`, `${password}`);

    const url = new URL(`${nodeUrl}/api/v1/payments/all/paginated`);
    url.searchParams.append('limit', limit.toString());
    url.searchParams.append('offset', offset.toString());
    url.searchParams.append('sortby', sortby);
    url.searchParams.append('direction', direction);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Error getting all payments (status: ${response.status} ${response.statusText})`,
      );
    }

    const data = await response.json();

    // The paginated endpoint has shipped the array bare and wrapped under
    // several keys across LNbits versions, so accept each known shape.
    const payments = Array.isArray(data)
      ? data
      : (data?.data ?? data?.payments ?? data?.items);

    if (!Array.isArray(payments)) {
      throw new Error(
        `Unexpected payload from ${url.pathname}: ${JSON.stringify(data)}`,
      );
    }

    return payments;
  } catch (error) {
    logger.error('Error in getAllPayments:', error);
    throw error;
  }
};

const createInvoice = async (
  lnKey: string,
  recipientWalletId: string,
  amount: number,
  memo: string,
) => {
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
      }),
    });

    if (!response.ok) {
      throw new Error(`Error creating an invoice (status: ${response.status})`);
    }

    const data = await response.json();

    return data.payment_request;
  } catch (error) {
    logger.error(error);
    throw error;
  }
};

const payInvoice = async (adminKey: string, paymentRequest: string) => {
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

  return response.json();
};

export {
  getWalletPayments,
  getInvoicePayment,
  getWalletTransactionsSince,
  getUserWalletTransactions,
  getAllPayments,
  createInvoice,
  payInvoice,
};
