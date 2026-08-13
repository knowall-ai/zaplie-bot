import {
  errorResponse,
  installFetchMock,
  jsonResponse,
} from '../../testUtils/fetchMock';
import {
  createInvoice,
  getAllPayments,
  getInvoicePayment,
  getUserWalletTransactions,
  getWalletPayments,
  getWalletTransactionsSince,
  payInvoice,
} from './payments';

jest.mock('./auth', () => ({
  getAccessToken: jest.fn(async () => 'test-token'),
}));

const rawPayment = (overrides: Record<string, unknown> = {}) => ({
  checking_id: 'check-1',
  payment_hash: 'hash-1',
  bolt11: 'lnbc1...',
  memo: 'Thanks',
  amount: 1000,
  wallet_id: 'w1',
  time: 1723500000,
  extra: {},
  ...overrides,
});

describe('lnbits payments', () => {
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    mockFetch = installFetchMock();
  });

  describe('createInvoice', () => {
    test('returns the payment request', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ payment_request: 'lnbc1...' }),
      );

      await expect(createInvoice('in-key', 'w1', 1000, 'memo')).resolves.toBe(
        'lnbc1...',
      );
    });

    test('throws when LNbits rejects the invoice', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(400, 'Bad Request'));

      await expect(createInvoice('in-key', 'w1', 1000, 'memo')).rejects.toThrow(
        'status: 400',
      );
    });
  });

  describe('payInvoice', () => {
    test('returns the settled payment', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ payment_hash: 'hash-1' }));

      await expect(payInvoice('admin-key', 'lnbc1...')).resolves.toEqual({
        payment_hash: 'hash-1',
      });
    });

    test('throws when LNbits rejects the payment', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(402, 'Payment Required'));

      await expect(payInvoice('admin-key', 'lnbc1...')).rejects.toThrow(
        'status: 402',
      );
    });
  });

  describe('getAllPayments', () => {
    test('returns a bare array untouched', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([rawPayment()]));

      await expect(getAllPayments()).resolves.toHaveLength(1);
    });

    test.each(['data', 'payments', 'items'])(
      'unwraps a payload wrapped in %p',
      async key => {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({ [key]: [rawPayment()] }),
        );

        await expect(getAllPayments()).resolves.toHaveLength(1);
      },
    );

    test('returns an empty list for an unrecognised payload shape', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ total: 0 }));

      await expect(getAllPayments()).resolves.toEqual([]);
    });

    test('throws when the endpoint fails', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500));

      await expect(getAllPayments()).rejects.toThrow('status: 500');
    });
  });

  describe('getWalletPayments', () => {
    test('returns the payments for the wallet', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([rawPayment()]));

      await expect(getWalletPayments('in-key')).resolves.toHaveLength(1);
    });

    // Odd one out: every other call in this module rethrows.
    test('swallows the error and returns null when the request fails', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500));

      await expect(getWalletPayments('in-key')).resolves.toBeNull();
    });
  });

  describe('getInvoicePayment', () => {
    test('throws when the invoice lookup fails', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

      await expect(getInvoicePayment('ln-key', 'hash-1')).rejects.toThrow(
        'status: 404',
      );
    });
  });

  describe('getWalletTransactionsSince', () => {
    test('maps the payload onto the Transaction shape', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([rawPayment()]));

      const transactions = await getWalletTransactionsSince('in-key', 0, null);

      expect(transactions[0]).toMatchObject({
        checking_id: 'check-1',
        memo: 'Thanks',
        amount: 1000,
        wallet_id: 'w1',
      });
    });

    test('falls back to payment_hash when checking_id is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([rawPayment({ checking_id: undefined })]),
      );

      const transactions = await getWalletTransactionsSince('in-key', 0, null);

      expect(transactions[0].checking_id).toBe('hash-1');
    });

    test('filters by the extra field when a filter is given', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          rawPayment({ checking_id: 'zap', extra: { tag: 'zap' } }),
          rawPayment({ checking_id: 'other', extra: { tag: 'topup' } }),
        ]),
      );

      const transactions = await getWalletTransactionsSince('in-key', 0, {
        tag: 'zap',
      });

      expect(transactions.map(t => t.checking_id)).toEqual(['zap']);
    });
  });

  describe('getUserWalletTransactions', () => {
    test('scopes the request to the wallet', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([rawPayment()]));

      await getUserWalletTransactions('w1', 'in-key', null);

      expect(String(mockFetch.mock.calls[0][0])).toContain('wallet=w1');
    });

    test('throws when the wallet transactions endpoint fails', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));

      await expect(
        getUserWalletTransactions('w1', 'in-key', null),
      ).rejects.toThrow('Failed to fetch transactions for wallet w1');
    });
  });
});
