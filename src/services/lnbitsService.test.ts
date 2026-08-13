import {
  expect,
  describe,
  test,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';

const BASE = 'https://lnbits.test';
const USERNAME = 'lnbits-admin';
const PASSWORD = 'lnbits-secret';

const originalFetch = global.fetch;
const originalNodeUrl = process.env.LNBITS_NODE_URL;
const originalUsername = process.env.LNBITS_USERNAME;
const originalPassword = process.env.LNBITS_PASSWORD;

type LnbitsService = typeof import('./lnbitsService');

const fetchMock = jest.fn<typeof fetch>();

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const lastRequest = () => {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: String(call[0]), init: call[1] };
};

const requestTo = (url: string) => {
  const call = fetchMock.mock.calls.find(c => String(c[0]) === url);
  if (!call) {
    throw new Error(
      `No fetch call to ${url}, saw: ${fetchMock.mock.calls.map(c => c[0])}`,
    );
  }
  return { url: String(call[0]), init: call[1] };
};

let service: LnbitsService;

beforeEach(() => {
  process.env.LNBITS_NODE_URL = BASE;
  process.env.LNBITS_USERNAME = USERNAME;
  process.env.LNBITS_PASSWORD = PASSWORD;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async input => {
    throw new Error(`Unexpected fetch call: ${input}`);
  });
  global.fetch = fetchMock;
  // The module caches the access token at module scope; each test gets a fresh copy.
  jest.resetModules();
  service = require('./lnbitsService');
});

const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

afterEach(() => {
  global.fetch = originalFetch;
  restoreEnv('LNBITS_NODE_URL', originalNodeUrl);
  restoreEnv('LNBITS_USERNAME', originalUsername);
  restoreEnv('LNBITS_PASSWORD', originalPassword);
  fetchMock.mockReset();
  jest.resetModules();
});

const stubAuth = (token = 'tok-1') => {
  fetchMock.mockImplementationOnce(async () =>
    jsonResponse({ access_token: token }),
  );
};

describe('getAccessToken', () => {
  test('POSTs the credentials to /api/v1/auth and returns the token', async () => {
    stubAuth('tok-1');

    const token = await service.getAccessToken('user-a', 'pass-a');

    expect(token).toBe('tok-1');
    expect(lastRequest()).toEqual({
      url: `${BASE}/api/v1/auth`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ username: 'user-a', password: 'pass-a' }),
      },
    });
  });

  test('caches the token: the second call does not hit the network', async () => {
    stubAuth('tok-1');

    await service.getAccessToken('user-a', 'pass-a');
    const second = await service.getAccessToken('user-a', 'pass-a');

    expect(second).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rejects on a non-2xx response', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(
        { detail: 'bad login' },
        { status: 401, statusText: 'Unauthorized' },
      ),
    );

    // The catch rethrows a generic error; the status code is only logged, not propagated.
    await expect(service.getAccessToken('user-a', 'wrong')).rejects.toThrow(
      'Failed to retrieve access token',
    );
  });

  test('rejects when the response is not JSON', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    );

    await expect(service.getAccessToken('user-a', 'pass-a')).rejects.toThrow(
      'Failed to retrieve access token',
    );
  });

  test('rejects on a network error', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(service.getAccessToken('user-a', 'pass-a')).rejects.toThrow(
      'Failed to retrieve access token',
    );
  });
});

describe('createInvoice', () => {
  test('POSTs an incoming payment with the invoice key and returns payment_request', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ payment_request: 'lnbc1invoice' }),
    );

    const result = await service.createInvoice(
      'in-key',
      'wallet-1',
      21,
      'memo text',
      {
        tag: 'zap',
      },
    );

    expect(result).toBe('lnbc1invoice');
    expect(lastRequest()).toEqual({
      url: `${BASE}/api/v1/payments`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': 'in-key',
        },
        body: JSON.stringify({
          out: false,
          amount: 21,
          memo: 'memo text',
          extra: { tag: 'zap' },
        }),
      },
    });
  });

  // createInvoice re-throws on a non-2xx response so callers can handle failures.
  test('rejects on a non-2xx response', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({}, { status: 500 }),
    );

    await expect(
      service.createInvoice('in-key', 'wallet-1', 21, 'memo', {}),
    ).rejects.toThrow('Error creating an invoice (status: 500)');
  });
});

describe('getWallets', () => {
  const rawWallet = {
    id: 'w-1',
    admin: 'admin-1',
    name: 'Alice - Allowance',
    adminkey: 'ak-1',
    user: 'u-1',
    inkey: 'ik-1',
  };
  const userWalletEntry = {
    id: 'w-1',
    admin: 'admin-1',
    name: 'Alice - Allowance',
    adminkey: 'ak-1',
    user: 'u-1',
    inkey: 'ik-1',
    balance_msat: 21000,
    deleted: false,
  };

  const stubWalletRoutes = (
    wallets: object[],
    userWallets: Record<string, object[]>,
  ) => {
    fetchMock.mockImplementation(async input => {
      const url = String(input);
      if (url === `${BASE}/api/v1/auth`)
        return jsonResponse({ access_token: 'tok-1' });
      if (url === `${BASE}/api/v1/wallets`) return jsonResponse(wallets);
      for (const [userId, entries] of Object.entries(userWallets)) {
        if (url === `${BASE}/users/api/v1/user/${userId}/wallet`)
          return jsonResponse(entries);
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
  };

  test('GETs /api/v1/wallets with a Bearer token and maps balance and deleted from the per-user route', async () => {
    stubWalletRoutes([rawWallet], { 'u-1': [userWalletEntry] });

    const wallets = await service.getWallets('admin-key');

    expect(wallets).toEqual([
      {
        id: 'w-1',
        admin: 'admin-1',
        name: 'Alice - Allowance',
        adminkey: 'ak-1',
        user: 'u-1',
        inkey: 'ik-1',
        balance_msat: 21000,
        deleted: false,
      },
    ]);

    const authReq = requestTo(`${BASE}/api/v1/auth`);
    expect(JSON.parse(String(authReq.init?.body))).toEqual({
      username: USERNAME,
      password: PASSWORD,
    });

    const walletsReq = requestTo(`${BASE}/api/v1/wallets`);
    expect(walletsReq.init?.method).toBe('GET');
    expect(walletsReq.init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok-1',
    });
  });

  test('filters wallets by name', async () => {
    const otherWallet = {
      ...rawWallet,
      id: 'w-2',
      name: 'Bob - Private',
      user: 'u-2',
    };
    stubWalletRoutes([rawWallet, otherWallet], {
      'u-1': [userWalletEntry],
      'u-2': [{ ...userWalletEntry, id: 'w-2', user: 'u-2' }],
    });

    const wallets = await service.getWallets('admin-key', 'Allowance');

    expect(wallets?.map(w => w.id)).toEqual(['w-1']);
  });

  // Bug: getWalletById pre-filters deleted entries and returns null, so the wallet
  // maps to deleted: undefined and survives the `!= true` filter.
  test.failing('excludes a wallet deleted on the per-user route', async () => {
    const deletedWallet = {
      ...rawWallet,
      id: 'w-3',
      name: 'Carol - Allowance',
      user: 'u-3',
    };
    stubWalletRoutes([rawWallet, deletedWallet], {
      'u-1': [userWalletEntry],
      'u-3': [{ ...userWalletEntry, id: 'w-3', user: 'u-3', deleted: true }],
    });

    const wallets = await service.getWallets('admin-key', 'Allowance');

    expect(wallets?.map(w => w.id)).toEqual(['w-1']);
  });

  // Bug: the catch returns the Error, so callers receive it as the resolved value.
  test.failing('rejects on a non-2xx response', async () => {
    stubAuth();
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({}, { status: 500 }),
    );

    await expect(service.getWallets('admin-key')).rejects.toThrow(
      'Error getting wallets response (status: 500)',
    );
  });
});

describe('getUserWallets', () => {
  test('GETs the per-user wallet route with a Bearer token and drops deleted wallets', async () => {
    stubAuth('tok-1');
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse([
        {
          id: 'w-1',
          name: 'Alice - Private',
          adminkey: 'ak-1',
          user: 'u-1',
          inkey: 'ik-1',
          balance_msat: 5000,
          deleted: false,
        },
        {
          id: 'w-2',
          name: 'Alice - Old',
          adminkey: 'ak-2',
          user: 'u-1',
          inkey: 'ik-2',
          balance_msat: 0,
          deleted: true,
        },
      ]),
    );

    const wallets = await service.getUserWallets('admin-key', 'u-1');

    expect(wallets).toEqual([
      {
        id: 'w-1',
        admin: null,
        name: 'Alice - Private',
        adminkey: 'ak-1',
        user: 'u-1',
        inkey: 'ik-1',
        balance_msat: 5000,
        deleted: false,
      },
    ]);
    expect(lastRequest()).toEqual({
      url: `${BASE}/users/api/v1/user/u-1/wallet`,
      init: {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-1',
        },
      },
    });
  });

  test('rejects on a non-2xx response', async () => {
    stubAuth();
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({}, { status: 404 }),
    );

    await expect(service.getUserWallets('admin-key', 'u-1')).rejects.toThrow(
      'Error getting users wallets response (status: 404)',
    );
  });

  test('rejects a wallet without a string name', async () => {
    stubAuth();
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse([{ id: 'w-1', user: 'u-1' }]),
    );

    await expect(service.getUserWallets('admin-key', 'u-1')).rejects.toThrow(
      'getUserWallets: LNbits returned a wallet without a string id or name',
    );
  });
});

describe('payInvoice', () => {
  test('POSTs an outgoing payment with the admin key and returns the payment data', async () => {
    const payment = { payment_hash: 'hash-1', checking_id: 'chk-1' };
    fetchMock.mockImplementationOnce(async () => jsonResponse(payment));

    const result = await service.payInvoice('admin-key', 'lnbc1invoice', {
      tag: 'zap',
    });

    expect(result).toEqual(payment);
    expect(lastRequest()).toEqual({
      url: `${BASE}/api/v1/payments`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': 'admin-key',
        },
        body: JSON.stringify({
          out: true,
          bolt11: 'lnbc1invoice',
          extra: { tag: 'zap' },
        }),
      },
    });
  });

  test('rejects on a non-2xx response', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({}, { status: 520 }),
    );

    await expect(
      service.payInvoice('admin-key', 'lnbc1invoice', {}),
    ).rejects.toThrow('Error paying invoice (status: 520)');
  });

  test('rejects on a network error', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(
      service.payInvoice('admin-key', 'lnbc1invoice', {}),
    ).rejects.toThrow('fetch failed');
  });
});
