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
    return 'lnbc1invoice';
  },
  payOwnedInvoice: async (input) => {
    calls.push(['payment', input]);
    return { payment_hash: 'hash-1' };
  },
  sendZap: async (input) => {
    calls.push(['zap', input]);
    return { payment_hash: 'hash-2' };
  },
};

const extractBearerToken = (req) => {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return match ? match[1] : null;
};

const verifyMsalPayload = async (token) => {
  if (token === 'valid-token') return { oid: 'caller-oid' };
  if (token === 'unlinked-token') return { oid: 'unlinked-oid' };
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
    body: { amount: 25, memo: 'thank you', aadObjectId: 'forged-oid' },
  });

  assert.equal(response.status, 201);
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
    { walletId: 'wallet-9', limit: undefined },
  ]);
});

test('rejects malformed or excessive zap amounts before calling LNbits', async () => {
  const callsBefore = calls.length;
  const response = await request('/api/lnbits/zaps', {
    method: 'POST',
    token: 'valid-token',
    body: { recipientUserId: 'user-2', amount: 1000001, memo: 'too much' },
  });

  assert.equal(response.status, 400);
  assert.equal(calls.length, callsBefore);
});
