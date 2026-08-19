import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  clearApiCache,
  createInvoice,
  getUserWallets,
  getWallets,
  payInvoice,
} from './lnbitsServiceLocal';
import { getMsalInstance } from './msalClient';

jest.mock('./msalClient', () => {
  const instance = {
    getActiveAccount: jest.fn(() => ({ localAccountId: 'aad-1' })),
    getAllAccounts: jest.fn(() => []),
    acquireTokenSilent: jest.fn(async () => ({ idToken: 'entra-id-token' })),
  };

  return { getMsalInstance: () => instance };
});

const msalInstance = getMsalInstance();

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
      .mockResolvedValueOnce(jsonResponse({ paymentRequest: 'lnbc1invoice' }))
      .mockResolvedValueOnce(
        jsonResponse({ payment_hash: 'hash-1', checking_id: 'check-1' }),
      );

    await expect(createInvoice('wallet-1', 10, 'thanks')).resolves.toBe(
      'lnbc1invoice',
    );
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
});
