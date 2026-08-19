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
    body: { amount: 25, memo: 'thank you', aadObjectId: 'forged-oid' },
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
