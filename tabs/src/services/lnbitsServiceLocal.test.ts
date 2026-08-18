import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  clearApiCache,
  createInvoice,
  getInvoicePayment,
  getUserWallets,
  getWallets,
  payInvoice,
  sendZap,
} from './lnbitsServiceLocal';
import { msalInstance } from './msalClient';

jest.mock('./msalClient', () => ({
  msalInstance: {
    getActiveAccount: jest.fn(() => ({ localAccountId: 'aad-1' })),
    getAllAccounts: jest.fn(() => []),
    acquireTokenSilent: jest.fn(async () => ({ idToken: 'entra-id-token' })),
  },
}));

global.fetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    json: async () => body,
  }) as unknown as Response;

const wallet: Wallet = {
  id: 'wallet-1',
  name: 'Private',
  user: 'user-1',
  balance_msat: 1000,
  deleted: false,
};

describe('LNbits same-origin API client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (msalInstance.getActiveAccount as jest.Mock).mockReturnValue({
      localAccountId: 'aad-1',
    });
    (msalInstance.getAllAccounts as jest.Mock).mockReturnValue([]);
    (msalInstance.acquireTokenSilent as jest.Mock).mockResolvedValue({
      idToken: 'entra-id-token',
    });
    clearApiCache();
  });

  test('uses an Entra token and never sends a wallet or admin key', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([wallet]));

    await expect(getWallets()).resolves.toEqual([wallet]);

    expect(msalInstance.acquireTokenSilent).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('/api/lnbits/wallets', {
      headers: { Authorization: 'Bearer entra-id-token' },
    });
    expect(JSON.stringify(mockFetch.mock.calls)).not.toMatch(/X-Api-Key/i);
  });

  test('lists wallets using only the user id in a same-origin path', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([wallet]));

    await expect(getUserWallets('user-1')).resolves.toEqual([wallet]);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/lnbits/users/user-1/wallets');
  });

  test('creates and pays invoices by wallet id', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ paymentRequest: 'lnbc1invoice', invoiceId: 'check-1' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ payment_hash: 'hash-1', checking_id: 'check-1' }),
      );

    await expect(createInvoice('wallet-1', 10, 'thanks')).resolves.toEqual({
      paymentRequest: 'lnbc1invoice',
      invoiceId: 'check-1',
    });
    await expect(payInvoice('wallet-1', 'lnbc1invoice')).resolves.toEqual({
      payment_hash: 'hash-1',
      checking_id: 'check-1',
    });

    expect(mockFetch.mock.calls[0][0]).toBe(
      '/api/lnbits/wallets/wallet-1/invoices',
    );
    expect(mockFetch.mock.calls[1][0]).toBe(
      '/api/lnbits/wallets/wallet-1/payments',
    );
  });

  test('sends a zap with the caller-provided idempotency key', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ payment_hash: 'hash-1' }));

    await sendZap('recipient-1', 20, 'thanks', 'request-1234567890');

    expect(mockFetch).toHaveBeenCalledWith('/api/lnbits/zaps', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer entra-id-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'request-1234567890',
      },
      body: JSON.stringify({
        recipientUserId: 'recipient-1',
        amount: 20,
        memo: 'thanks',
      }),
    });
  });

  test('rejects incomplete invoice and payment responses', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ paymentRequest: 'lnbc1invoice' }))
      .mockResolvedValueOnce(jsonResponse({ checking_id: 'check-1' }))
      .mockResolvedValueOnce(jsonResponse({ pending: true }));

    await expect(createInvoice('wallet-1', 10, 'thanks')).rejects.toThrow(
      'The invoice service returned an invalid response.',
    );
    await expect(payInvoice('wallet-1', 'lnbc1invoice')).rejects.toThrow(
      'The payment service returned an invalid response.',
    );
    await expect(getInvoicePayment('wallet-1', 'check-1')).rejects.toThrow(
      'The invoice status response was invalid.',
    );
  });
});
