// The provisioning gate reads the home tenant and the guest allowlist from
// the environment, like the bot does; set before the router is created.
process.env.AAD_TENANT_ID = 'home-tenant';
process.env.ZAPLIE_GUEST_ALLOWLIST = 'guest.ok@partner.test';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const { createLnbitsRouter } = require('./lnbitsRoutes');

const calls = [];
const service = {
  assertCaller: async (oid) => {
    if (oid === 'unlinked-oid') {
      const error = new Error('No LNbits user is linked to this account');
      error.status = 403;
      throw error;
    }
  },
  maxZapAmountSats: () => 5_000,
  listUsers: async () => [{ id: 'user-1' }],
  getWalletBalance: async (walletId, aadObjectId) => {
    calls.push(['balance', { walletId, aadObjectId }]);
    return 42;
  },
  getWalletDetails: async (walletId, aadObjectId) => {
    calls.push(['details', { walletId, aadObjectId }]);
    return { id: walletId };
  },
  getWalletPayLinks: async (walletId, aadObjectId) => {
    calls.push(['paylinks', { walletId, aadObjectId }]);
    return [];
  },
  getInvoicePayment: async (walletId, invoiceId, aadObjectId) => {
    calls.push(['invoice-lookup', { walletId, invoiceId, aadObjectId }]);
    return {};
  },
  listWalletPayments: async (walletId, limit) => {
    calls.push(['payments', { walletId, limit }]);
    return [];
  },
  createOwnedInvoice: async (input) => {
    calls.push(['invoice', input]);
    return {
      paymentRequest: 'lnbc1invoice',
      invoiceId: 'invoice-1',
    };
  },
  payOwnedInvoice: async (input) => {
    calls.push(['payment', input]);
    return { payment_hash: 'hash-1' };
  },
  sendZap: async (input) => {
    calls.push(['zap', input]);
    return { payment_hash: 'hash-2' };
  },
  ensureCaller: async (input) => {
    calls.push(['ensure', input]);
    return { user: { id: 'user-new' }, created: true, createdWallets: [] };
  },
};

const extractBearerToken = (req) => {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return match ? match[1] : null;
};

const verifyMsalPayload = async (token) => {
  if (token === 'valid-token') return { oid: 'caller-oid' };
  if (token === 'unlinked-token')
    return {
      oid: 'unlinked-oid',
      tid: 'home-tenant',
      acct: 0,
      name: 'New Person',
      preferred_username: 'new.person@example.test',
    };
  if (token === 'guest-token')
    return { oid: 'unlinked-oid', tid: 'home-tenant', acct: 1, preferred_username: 'g@other.test' };
  if (token === 'allowlisted-guest-token')
    return { oid: 'unlinked-oid', tid: 'home-tenant', acct: 1, preferred_username: 'Guest.OK@partner.test' };
  if (token === 'other-tenant-token')
    return { oid: 'unlinked-oid', tid: 'elsewhere', acct: 0 };
  if (token === 'no-claims-token') return { oid: 'unlinked-oid' };
  if (token === 'no-acct-token') return { oid: 'unlinked-oid', tid: 'home-tenant' };
  throw new Error('bad token');
};

const app = express();
app.use(express.json());
app.use(
  '/api/lnbits',
  createLnbitsRouter({ service, extractBearerToken, verifyMsalPayload }),
);

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const request = (path, options = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.token
        ? { Authorization: `Bearer ${options.token}` }
        : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

test('requires a verified token and a linked LNbits user', async () => {
  assert.equal((await request('/api/lnbits/users')).status, 401);
  assert.equal(
    (await request('/api/lnbits/users', { token: 'unlinked-token' })).status,
    403,
  );
  const response = await request('/api/lnbits/users', { token: 'valid-token' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id: 'user-1' }]);
});

test('derives wallet-write authorization from the verified oid', async () => {
  const response = await request('/api/lnbits/wallets/wallet-1/invoices', {
    method: 'POST',
    token: 'valid-token',
    body: { amount: 25, memo: 'thank you' },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    paymentRequest: 'lnbc1invoice',
    invoiceId: 'invoice-1',
  });
  assert.deepEqual(calls.at(-1), [
    'invoice',
    {
      walletId: 'wallet-1',
      amount: 25,
      memo: 'thank you',
      aadObjectId: 'caller-oid',
    },
  ]);
});

// A body field the route does not read is refused rather than ignored: a caller
// that thinks it can name its own oid gets told no, instead of getting a 201
// that quietly used somebody else's identity.
test('write routes refuse body fields they do not read', async () => {
  const forged = [
    ['/api/lnbits/wallets/wallet-1/invoices', { amount: 25, memo: 'hi', aadObjectId: 'forged-oid' }],
    ['/api/lnbits/wallets/wallet-1/invoices', { amount: 25, memo: 'hi', walletId: 'wallet-9' }],
    ['/api/lnbits/wallets/wallet-1/payments', { paymentRequest: 'lnbc1', aadObjectId: 'forged-oid' }],
    ['/api/lnbits/zaps', { recipientUserId: 'user-2', amount: 25, memo: 'hi', aadObjectId: 'forged-oid' }],
  ];

  for (const [path, body] of forged) {
    const callsBefore = calls.length;
    const response = await request(path, { method: 'POST', token: 'valid-token', body });

    assert.equal(response.status, 400);
    assert.equal(calls.length, callsBefore);
  }
});

test('wallet reads carry the verified oid so a wallet id alone grants nothing', async () => {
  const reads = [
    ['/api/lnbits/wallets/wallet-9', 'details'],
    ['/api/lnbits/wallets/wallet-9/balance', 'balance'],
    ['/api/lnbits/wallets/wallet-9/paylinks', 'paylinks'],
    ['/api/lnbits/wallets/wallet-9/payments/invoice-9', 'invoice-lookup'],
  ];

  for (const [path, kind] of reads) {
    const response = await request(path, { token: 'valid-token' });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1)[0], kind);
    assert.equal(calls.at(-1)[1].aadObjectId, 'caller-oid');
  }
});

test('wallet payment history stays tenant-wide for the feed', async () => {
  const response = await request('/api/lnbits/wallets/wallet-9/payments', {
    token: 'valid-token',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.at(-1), [
    'payments',
    { walletId: 'wallet-9', limit: 100 },
  ]);
});

test('requires an idempotency key and passes it with authenticated zap data', async () => {
  const missingKey = await request('/api/lnbits/zaps', {
    method: 'POST',
    token: 'valid-token',
    body: { recipientUserId: 'user-2', amount: 20, memo: 'thank you' },
  });
  assert.equal(missingKey.status, 400);

  const response = await request('/api/lnbits/zaps', {
    method: 'POST',
    token: 'valid-token',
    headers: { 'Idempotency-Key': 'zap-request-00000001' },
    body: { recipientUserId: 'user-2', amount: 20, memo: 'thank you' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.at(-1), [
    'zap',
    {
      recipientUserId: 'user-2',
      amount: 20,
      memo: 'thank you',
      aadObjectId: 'caller-oid',
      idempotencyKey: 'zap-request-00000001',
    },
  ]);
});

test('rejects zap amounts above the cap reported by the injected service', async () => {
  const callsBefore = calls.length;
  const response = await request('/api/lnbits/zaps', {
    method: 'POST',
    token: 'valid-token',
    headers: { 'Idempotency-Key': 'zap-request-00000002' },
    body: { recipientUserId: 'user-2', amount: 5001, memo: 'too much' },
  });

  assert.equal(response.status, 400);
  assert.equal(calls.length, callsBefore);
});

test('rejects non-numeric amounts that would otherwise coerce to a number', async () => {
  for (const amount of [true, ['5'], '25', null, 25.5]) {
    const callsBefore = calls.length;
    const response = await request('/api/lnbits/zaps', {
      method: 'POST',
      token: 'valid-token',
      body: { recipientUserId: 'user-2', amount, memo: 'coerced' },
    });

    assert.equal(response.status, 400);
    assert.equal(calls.length, callsBefore);
  }
});

test('rejects pagination values that are not plain integers', async () => {
  for (const limit of ['10.5', '1e3', '-1', '0', '9999', 'abc']) {
    const callsBefore = calls.length;
    const response = await request(
      `/api/lnbits/wallets/wallet-9/payments?limit=${limit}`,
      { token: 'valid-token' },
    );

    assert.equal(response.status, 400);
    assert.equal(calls.length, callsBefore);
  }
});

// POST /users/me is the one route a person without an LNbits user may reach:
// it is how they get one. It still needs a verified token, and it acts on the
// token's oid, never on anything in the body.
test('only members and allowlisted guests can provision; nothing is created otherwise', async () => {
  for (const token of ['guest-token', 'other-tenant-token', 'no-claims-token', 'no-acct-token']) {
    const before = calls.length;
    const response = await request('/api/lnbits/users/me', { method: 'POST', token });
    assert.equal(response.status, 403, token);
    assert.equal(calls.length, before, `${token} must create nothing`);
  }

  const response = await request('/api/lnbits/users/me', {
    method: 'POST',
    token: 'allowlisted-guest-token',
  });
  assert.equal(response.status, 200);
  assert.equal(calls.at(-1)[0], 'ensure');
  assert.equal(calls.at(-1)[1].email, 'Guest.OK@partner.test');
});

test('a person already in LNbits keeps every route, whatever their membership', async () => {
  // valid-token carries no tid or acct at all: existing users are not gated.
  const response = await request('/api/lnbits/users', { token: 'valid-token' });
  assert.equal(response.status, 200);
});

test('an unlinked member can provision themselves, from the token alone', async () => {
  assert.equal(
    (await request('/api/lnbits/users/me', { method: 'POST' })).status,
    401,
  );

  const response = await request('/api/lnbits/users/me', {
    method: 'POST',
    token: 'unlinked-token',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    user: { id: 'user-new' },
    created: true,
    createdWallets: [],
  });
  assert.deepEqual(calls.at(-1), [
    'ensure',
    {
      aadObjectId: 'unlinked-oid',
      displayName: 'New Person',
      email: 'new.person@example.test',
    },
  ]);
});

test('provisioning refuses a body that tries to name the identity', async () => {
  const before = calls.length;
  const response = await request('/api/lnbits/users/me', {
    method: 'POST',
    token: 'valid-token',
    body: { aadObjectId: 'forged-oid' },
  });

  assert.equal(response.status, 400);
  assert.equal(calls.length, before);
});
