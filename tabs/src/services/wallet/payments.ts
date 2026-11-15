import { apiRequest } from './gateway';

export interface PaymentResult {
  payment_hash: string;
  checking_id?: string;
}

const matchesExtra = (
  transaction: Transaction,
  filterByExtra: { [key: string]: string },
): boolean =>
  Object.keys(filterByExtra).every(
    key => transaction.extra?.[key] === filterByExtra[key],
  );

const getWalletPayments = async (walletId: string): Promise<Transaction[]> =>
  apiRequest<Transaction[]>(
    `/wallets/${encodeURIComponent(walletId)}/payments?limit=100`,
  );

const getInvoicePayment = async (walletId: string, invoice: string) =>
  apiRequest<unknown>(
    `/wallets/${encodeURIComponent(walletId)}/payments/${encodeURIComponent(invoice)}`,
  );

const getWalletTransactionsSince = async (
  walletId: string,
  timestamp: number,
  filterByExtra: { [key: string]: string } | null, // Pass the extra field as an object
): Promise<Transaction[]> => {
  const transactions = await getWalletPayments(walletId);

  // The endpoint returns the latest payments regardless of age, so the
  // timestamp cut-off has to be applied client-side too.
  return transactions.filter(transaction => {
    const time =
      typeof transaction.time === 'number'
        ? transaction.time
        : Date.parse(transaction.time) / 1000;
    if (timestamp > 0 && (!Number.isFinite(time) || time < timestamp)) {
      return false;
    }
    return filterByExtra ? matchesExtra(transaction, filterByExtra) : true;
  });
};

const getUserWalletTransactions = async (
  walletId: string,
  filterByExtra: { [key: string]: string } | null,
): Promise<Transaction[]> =>
  getWalletTransactionsSince(walletId, 0, filterByExtra);

const getAllPayments = async (
  limit: number = 1000,
  offset: number = 0,
  sortby: string = 'time',
  direction: string = 'desc',
): Promise<Transaction[]> => {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sortby,
    direction,
  });
  return apiRequest<Transaction[]>(`/payments?${params}`);
};

const createInvoice = async (
  walletId: string,
  amount: number,
  memo: string,
): Promise<string> => {
  const result = await apiRequest<{ paymentRequest: string }>(
    `/wallets/${encodeURIComponent(walletId)}/invoices`,
    {
      method: 'POST',
      body: JSON.stringify({ amount, memo }),
    },
  );
  return result.paymentRequest;
};

const payInvoice = async (
  walletId: string,
  paymentRequest: string,
): Promise<PaymentResult> =>
  apiRequest<PaymentResult>(
    `/wallets/${encodeURIComponent(walletId)}/payments`,
    {
      method: 'POST',
      body: JSON.stringify({ paymentRequest }),
    },
  );

// randomUUID only exists in a secure context, so fall back to random bytes
// rather than throw on a path that moves money. Both shapes satisfy the
// gateway's own key pattern; a weaker source is refused outright, because a
// guessable key would let one zap replay another's recorded result.
export const newIdempotencyKey = (): string => {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  if (typeof webCrypto?.getRandomValues === 'function') {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  }
  throw new Error('Cannot generate a zap idempotency key: no Web Crypto');
};

// One call so the gateway picks the sender's Allowance wallet and the
// recipient's Private wallet; the browser never learns either wallet key.
//
// The key is required rather than defaulted: a default is evaluated per call,
// so a caller retrying after a timeout would mint a new key and pay twice,
// which is the exact thing the gateway's idempotency layer exists to stop. The
// caller must hold one key for as long as it keeps retrying the same zap.
const sendZap = async (
  recipientUserId: string,
  amount: number,
  memo: string,
  idempotencyKey: string,
): Promise<PaymentResult> =>
  apiRequest<PaymentResult>('/zaps', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ recipientUserId, amount, memo }),
  });

export {
  getWalletPayments,
  getInvoicePayment,
  getWalletTransactionsSince,
  getUserWalletTransactions,
  getAllPayments,
  createInvoice,
  payInvoice,
  sendZap,
};
