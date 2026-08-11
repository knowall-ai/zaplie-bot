import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';

const mockFetch = jest.fn<typeof fetch>();
let lnbitsService: typeof import('./lnbitsService');

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    json: async () => body,
  } as unknown as Response;
}

describe('lnbitsService HTTP behavior', () => {
  beforeEach(async () => {
    jest.resetModules();
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
    process.env.LNBITS_NODE_URL = 'https://lnbits.test';
    process.env.LNBITS_USERNAME = 'service-user';
    process.env.LNBITS_PASSWORD = 'service-password';
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    lnbitsService = await import('./lnbitsService');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.LNBITS_NODE_URL;
    delete process.env.LNBITS_USERNAME;
    delete process.env.LNBITS_PASSWORD;
  });

  test('gets an access token from LNbits and reuses the in-memory cache', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: 'access-token' }),
    );

    await expect(
      lnbitsService.getAccessToken('service-user', 'service-password'),
    ).resolves.toBe('access-token');
    await expect(
      lnbitsService.getAccessToken('service-user', 'service-password'),
    ).resolves.toBe('access-token');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://lnbits.test/api/v1/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        username: 'service-user',
        password: 'service-password',
      }),
    });
  });

  test('creates an invoice through the LNbits payments endpoint', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ payment_request: 'lnbc-payment-request' }),
    );

    await expect(
      lnbitsService.createInvoice(
        'invoice-key',
        'wallet-1',
        210,
        'GitHub reward',
        { source: 'github' },
      ),
    ).resolves.toBe('lnbc-payment-request');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://lnbits.test/api/v1/payments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': 'invoice-key',
        },
        body: JSON.stringify({
          out: false,
          amount: 210,
          memo: 'GitHub reward',
          extra: { source: 'github' },
        }),
      },
    );
  });

  test('loads a user wallet collection and removes deleted wallets', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'access-token' }))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'wallet-active',
            name: 'Private',
            user: 'user-1',
            adminkey: 'admin-key',
            inkey: 'invoice-key',
            balance_msat: 210000,
            deleted: false,
          },
          {
            id: 'wallet-deleted',
            name: 'Old wallet',
            user: 'user-1',
            adminkey: 'old-admin-key',
            inkey: 'old-invoice-key',
            balance_msat: 0,
            deleted: true,
          },
        ]),
      );

    await expect(
      lnbitsService.getUserWallets('unused-admin-key', 'user-1'),
    ).resolves.toEqual([
      {
        id: 'wallet-active',
        admin: null,
        name: 'Private',
        user: 'user-1',
        adminkey: 'admin-key',
        inkey: 'invoice-key',
        balance_msat: 210000,
        deleted: false,
      },
    ]);

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://lnbits.test/users/api/v1/user/user-1/wallet',
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer access-token',
        },
      },
    );
  });

  test('pays an invoice with the treasury key and preserves payment metadata', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ payment_hash: 'hash-1' }));

    await expect(
      lnbitsService.payInvoice('treasury-key', 'lnbc-payment-request', {
        source: 'github',
      }),
    ).resolves.toEqual({ payment_hash: 'hash-1' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://lnbits.test/api/v1/payments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': 'treasury-key',
        },
        body: JSON.stringify({
          out: true,
          bolt11: 'lnbc-payment-request',
          extra: { source: 'github' },
        }),
      },
    );
  });
});
