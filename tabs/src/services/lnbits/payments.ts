import { logger } from '../../utils/logger';
import { getAccessToken } from './auth';
import { nodeUrl, password, userName } from './config';

const getWalletPayments = async (inKey: string) => {
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
    logger.error('Error:', error);
    return null;
  }
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

    logger.debug('DATA', data);

    // Show all payments (timestamp filter removed)
    const paymentsSince = data;

    // Further filter by the `extra` field (if provided)
    const filteredPayments = filterByExtra
      ? paymentsSince.filter((payment: any) => {
          const paymentExtra = payment.extra || {};
          return Object.keys(filterByExtra).every(
            key => paymentExtra[key] === filterByExtra[key],
          );
        })
      : paymentsSince;

    logger.debug('DATA2', filteredPayments);

    const transactionData: Transaction[] = filteredPayments.map(
      (transaction: any) => ({
        checking_id:
          transaction.checking_id || transaction.payment_hash || transaction.id,
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

    //logger.debug('Transactions:', transactionData);

    return transactionData;
  } catch (error) {
    logger.error(error);
    throw error;
  }
};

const getUserWalletTransactions = async (
  walletId: string,
  apiKey: string,
  filterByExtra: { [key: string]: string } | null, // Pass the extra field as an object
): Promise<Transaction[]> => {
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

    const data = await response.json();

    // Further filter by the `extra` field (if provided)
    const filteredPayments = filterByExtra
      ? data.filter((payment: any) => {
          const paymentExtra = payment.extra || {};
          return Object.keys(filterByExtra).every(
            key => paymentExtra[key] === filterByExtra[key],
          );
        })
      : data;

    /*logger.debug(
      `Transactions fetched for wallet: ${walletId}`,
      filteredPayments,
    );*/ // Log fetched data
    return filteredPayments; // Assuming data is an array of transactions
  } catch (error) {
    logger.error(`Error fetching transactions for wallet ${walletId}:`, error);
    throw error; // Re-throw the error to handle it in the parent function
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

    logger.debug('Full URL:', url.toString());

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      logger.error('Response status:', response.status);
      logger.error('Response statusText:', response.statusText);
      throw new Error(
        `Error getting all payments (status: ${response.status})`,
      );
    }

    const data = await response.json();
    logger.debug('Raw response data:', data);
    logger.debug('Data type:', typeof data);
    logger.debug('Is array:', Array.isArray(data));

    // The API might return an object with a 'data' or 'payments' property
    let payments = data;

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.data && Array.isArray(data.data)) {
        payments = data.data;
      } else if (data.payments && Array.isArray(data.payments)) {
        payments = data.payments;
      } else if (data.items && Array.isArray(data.items)) {
        payments = data.items;
      }
    }

    logger.debug('Total payments retrieved:', payments?.length || 0);
    logger.debug('Sample payment:', payments?.[0]);
    logger.debug('===========================');

    return Array.isArray(payments) ? payments : [];
  } catch (error) {
    logger.error('Error in getAllPayments:', error);
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
    logger.error(error);
    throw error;
  }
};

const payInvoice = async (adminKey: string, paymentRequest: string) => {
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

export {
  getWalletPayments,
  getInvoicePayment,
  getWalletTransactionsSince,
  getUserWalletTransactions,
  getAllPayments,
  createInvoice,
  payInvoice,
};
