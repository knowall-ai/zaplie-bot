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

describe('scheduledTopup', () => {
  const ADMIN_KEY = 'admin-key';
  const IN_KEY = 'in-key';
  const HOST_USER_ID = 'host-user';
  const HOST_WALLET_ID = 'host-wallet';
  const ALLOWANCE = '5000';

  const topupEnv: Record<string, string> = {
    LNBITS_ADMINKEY: ADMIN_KEY,
    LNBITS_INKEY: IN_KEY,
    LNBITS_HOST_USER_ID: HOST_USER_ID,
    LNBITS_HOST_WALLET_ID: HOST_WALLET_ID,
    LNBITS_INITIAL_ALLOWANCE: ALLOWANCE,
  };
  const originalTopupEnv = Object.keys(topupEnv).map(
    key => [key, process.env[key]] as const,
  );

  beforeEach(() => {
    Object.assign(process.env, topupEnv);
  });

  afterEach(() => {
    originalTopupEnv.forEach(([key, value]) => restoreEnv(key, value));
  });

  type AllowanceHolder = {
    userId: string;
    walletId: string;
    displayName: string;
    balanceMsat: number;
  };

  type PaymentExtra = { from: { id: string }; to: unknown; tag: string };
  type PaymentBody = {
    out: boolean;
    amount?: number;
    memo?: string;
    bolt11?: string;
    extra: PaymentExtra;
  };
  type TopupBody = { id: string; amount: number };

  const alice: AllowanceHolder = {
    userId: 'u-1',
    walletId: 'w-1',
    displayName: 'Alice Smith',
    balanceMsat: 21000,
  };
  const bob: AllowanceHolder = {
    userId: 'u-2',
    walletId: 'w-2',
    displayName: 'Bob Jones',
    balanceMsat: 7000,
  };

  const listEntry = (holder: AllowanceHolder) => ({
    id: holder.walletId,
    admin: `${holder.walletId}-admin`,
    name: 'Allowance',
    adminkey: `${holder.walletId}-ak`,
    user: holder.userId,
    inkey: `${holder.walletId}-ik`,
  });

  const walletEntry = (holder: AllowanceHolder) => ({
    ...listEntry(holder),
    balance_msat: holder.balanceMsat,
    deleted: false,
  });

  const hostWallet = {
    id: HOST_WALLET_ID,
    admin: 'host-admin',
    name: 'Host',
    adminkey: 'host-ak',
    user: HOST_USER_ID,
    inkey: 'host-ik',
    balance_msat: 900000,
    deleted: false,
  };

  const stubTopupRoutes = (
    holders: AllowanceHolder[],
    responses: {
      wallets?: () => Response;
      host?: () => Response;
      invoice?: (body: PaymentBody) => Response;
      payment?: (body: PaymentBody) => Response;
      topup?: (body: TopupBody) => Response;
    } = {},
  ) => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${BASE}/api/v1/auth`)
        return jsonResponse({ access_token: 'tok-1' });
      if (url === `${BASE}/api/v1/wallets`)
        return responses.wallets
          ? responses.wallets()
          : jsonResponse(holders.map(listEntry));
      if (url === `${BASE}/users/api/v1/user/${HOST_USER_ID}/wallet`)
        return responses.host ? responses.host() : jsonResponse([hostWallet]);
      const holder = holders.find(
        candidate =>
          url === `${BASE}/users/api/v1/user/${candidate.userId}` ||
          url === `${BASE}/users/api/v1/user/${candidate.userId}/wallet`,
      );
      if (holder) {
        return url.endsWith('/wallet')
          ? jsonResponse([walletEntry(holder)])
          : jsonResponse({
              id: holder.userId,
              extra: { display_name: holder.displayName },
            });
      }
      if (url === `${BASE}/api/v1/payments`) {
        const body = JSON.parse(String(init?.body)) as PaymentBody;
        if (body.out) {
          return responses.payment
            ? responses.payment(body)
            : jsonResponse({ payment_hash: 'hash-1' });
        }
        return responses.invoice
          ? responses.invoice(body)
          : jsonResponse({ payment_request: 'lnbc1invoice' });
      }
      if (url === `${BASE}/users/api/v1/balance`) {
        const body = JSON.parse(String(init?.body)) as TopupBody;
        return responses.topup
          ? responses.topup(body)
          : jsonResponse({ id: body.id, balance: body.amount });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
  };

  const paymentRequests = (out: boolean) =>
    fetchMock.mock.calls
      .filter(call => String(call[0]) === `${BASE}/api/v1/payments`)
      .map(call => ({
        headers: call[1]?.headers as Record<string, string>,
        body: JSON.parse(String(call[1]?.body)) as PaymentBody,
      }))
      .filter(request => request.body.out === out);

  const topupRequests = () =>
    fetchMock.mock.calls
      .filter(call => String(call[0]) === `${BASE}/users/api/v1/balance`)
      .map(call => ({
        init: call[1],
        body: JSON.parse(String(call[1]?.body)) as TopupBody,
      }));

  const settleBackgroundWork = async () => {
    let seen = -1;
    while (seen !== fetchMock.mock.calls.length) {
      seen = fetchMock.mock.calls.length;
      for (let tick = 0; tick < 5; tick++) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  };

  const collectUnawaitedRejections = async (run: () => Promise<void>) => {
    const rejections: unknown[] = [];
    const originalForEach = Array.prototype.forEach;
    Array.prototype.forEach = function patchedForEach(
      this: unknown[],
      callback: (...args: unknown[]) => unknown,
      thisArg?: unknown,
    ) {
      originalForEach.call(this, (...args: unknown[]) => {
        const result = callback.apply(thisArg, args);
        if (result instanceof Promise) {
          result.catch(error => rejections.push(error));
        }
      });
    } as unknown as typeof Array.prototype.forEach;

    try {
      await run();
    } finally {
      Array.prototype.forEach = originalForEach;
    }
    await settleBackgroundWork();
    return rejections.map(String);
  };

  test('clears the allowance wallet into the host wallet and restores the allowance', async () => {
    stubTopupRoutes([alice]);

    await service.scheduledTopup();
    await settleBackgroundWork();

    const invoices = paymentRequests(false);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].headers['X-Api-Key']).toBe(IN_KEY);
    expect(invoices[0].body).toEqual({
      out: false,
      amount: 21,
      memo: 'Alice Smith Weekly Allowance cleared',
      extra: { from: walletEntry(alice), to: hostWallet, tag: 'zap' },
    });

    const payments = paymentRequests(true);
    expect(payments).toHaveLength(1);
    expect(payments[0].headers['X-Api-Key']).toBe(`${alice.walletId}-ak`);
    expect(payments[0].body).toEqual({
      out: true,
      bolt11: 'lnbc1invoice',
      extra: { from: walletEntry(alice), to: hostWallet, tag: 'zap' },
    });

    const topups = topupRequests();
    expect(topups).toHaveLength(1);
    expect(topups[0].init?.method).toBe('PUT');
    expect(topups[0].init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok-1',
    });
    expect(topups[0].body).toEqual({ id: alice.walletId, amount: 5000 });
  });

  test('awaits the host wallet lookup so the payment extra carries the wallet and not a pending promise', async () => {
    stubTopupRoutes([alice]);

    await service.scheduledTopup();
    await settleBackgroundWork();

    const requests = [...paymentRequests(false), ...paymentRequests(true)];
    expect(requests).toHaveLength(2);
    requests.forEach(request => {
      expect(request.body.extra.to).not.toEqual({});
      expect(request.body.extra.to).toEqual(hostWallet);
    });
  });

  test('tops up a wallet with no balance without creating a payment', async () => {
    stubTopupRoutes([{ ...alice, balanceMsat: 0 }]);

    await service.scheduledTopup();
    await settleBackgroundWork();

    expect(paymentRequests(false)).toHaveLength(0);
    expect(paymentRequests(true)).toHaveLength(0);
    expect(topupRequests().map(request => request.body)).toEqual([
      { id: alice.walletId, amount: 5000 },
    ]);
  });

  test('touches no wallet when there is no allowance wallet to process', async () => {
    stubTopupRoutes([]);

    await service.scheduledTopup();
    await settleBackgroundWork();

    expect(paymentRequests(false)).toHaveLength(0);
    expect(topupRequests()).toHaveLength(0);
  });

  test('returns before the per wallet payment chain has run', async () => {
    stubTopupRoutes([alice]);

    await service.scheduledTopup();
    const callsOnReturn = fetchMock.mock.calls.length;
    const paymentsOnReturn = paymentRequests(false).length;
    await settleBackgroundWork();

    expect(paymentsOnReturn).toBe(0);
    expect(paymentRequests(false)).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsOnReturn);
  });

  test('rejects with a TypeError when listing the allowance wallets fails, because getWallets resolves with the error', async () => {
    stubTopupRoutes([alice], {
      wallets: () => jsonResponse({}, { status: 500 }),
    });

    await expect(service.scheduledTopup()).rejects.toThrow(TypeError);
  });

  test('rejects when the host wallet lookup fails at the network level', async () => {
    stubTopupRoutes([alice], {
      host: () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(service.scheduledTopup()).rejects.toThrow('fetch failed');
  });

  test('still moves the balance when the host wallet lookup returns a non-2xx and records a null recipient', async () => {
    stubTopupRoutes([alice], { host: () => jsonResponse({}, { status: 500 }) });

    await service.scheduledTopup();
    await settleBackgroundWork();

    const invoices = paymentRequests(false);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].body.extra.to).toBeNull();
    expect(topupRequests()).toHaveLength(1);
  });

  test('reports a failed invoice creation only as an unawaited rejection and leaves the wallet untouched', async () => {
    stubTopupRoutes([alice], {
      invoice: () => jsonResponse({}, { status: 500 }),
    });

    const rejections = await collectUnawaitedRejections(() =>
      service.scheduledTopup(),
    );

    expect(rejections).toEqual([
      'Error: Error creating an invoice (status: 500)',
    ]);
    expect(paymentRequests(true)).toHaveLength(0);
    expect(topupRequests()).toHaveLength(0);
  });

  test('reports a failed payment only as an unawaited rejection and skips the top-up', async () => {
    stubTopupRoutes([alice], {
      payment: () => jsonResponse({}, { status: 502 }),
    });

    const rejections = await collectUnawaitedRejections(() =>
      service.scheduledTopup(),
    );

    expect(rejections).toEqual(['Error: Error paying invoice (status: 502)']);
    expect(topupRequests()).toHaveLength(0);
  });

  test('keeps processing the other wallets when one wallet payment fails', async () => {
    stubTopupRoutes([alice, bob], {
      payment: body =>
        body.extra.from.id === alice.walletId
          ? jsonResponse({}, { status: 502 })
          : jsonResponse({ payment_hash: 'hash-1' }),
    });

    const rejections = await collectUnawaitedRejections(() =>
      service.scheduledTopup(),
    );

    expect(rejections).toEqual(['Error: Error paying invoice (status: 502)']);
    expect(topupRequests().map(request => request.body)).toEqual([
      { id: bob.walletId, amount: 5000 },
    ]);
  });

  test('swallows a failed top-up so the caller cannot tell the allowance was not restored', async () => {
    stubTopupRoutes([alice, bob], {
      topup: body =>
        body.id === alice.walletId
          ? jsonResponse({}, { status: 500 })
          : jsonResponse({ id: body.id, balance: body.amount }),
    });

    const rejections = await collectUnawaitedRejections(() =>
      service.scheduledTopup(),
    );

    expect(rejections).toEqual([]);
    expect(paymentRequests(true)).toHaveLength(2);
    expect(
      topupRequests()
        .map(request => request.body.id)
        .sort(),
    ).toEqual([alice.walletId, bob.walletId]);
  });
});
