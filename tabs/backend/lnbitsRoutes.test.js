const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const { createLnbitsRouter } = require('./lnbitsRoutes');

const calls = [];
const ensureCalls = [];
const service = {
  ensureCaller: async (profile) => {
    ensureCalls.push(profile);
    if (profile.aadObjectId === 'unprovisionable-oid') {
      const error = new Error(
        'We could not create your Zaplie wallet yet — try again',
      );
      error.status = 503;
      error.expose = true;
      throw error;
    }
    if (profile.aadObjectId === 'unlinked-oid') {
      return { user: { id: 'user-new' }, provisioned: true };
    }
    return { user: { id: 'user-1' }, provisioned: false };
  },
  listUsers: async () => [{ id: 'user-1' }],
  listUserWallets: async (userId) => {
    calls.push(['wallets', userId]);
    return [{ id: `${userId}-private`, name: 'Private' }];
  },
  repairCallerWallets: async (userId, wallets) => {
    calls.push(['repair', userId]);
    return [...wallets, { id: `${userId}-allowance`, name: 'Allowance' }];
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
};

const extractBearerToken = (req) => {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return match ? match[1] : null;
};

const verifyMsalPayload = async (token) => {
  if (token === 'valid-token') return { oid: 'caller-oid' };
  if (token === 'unlinked-token') {
    return {
      oid: 'unlinked-oid',
      name: 'Ada Lovelace',
      preferred_username: 'ada@example.com',
      upn: 'ada@example.com',
    };
  }
  if (token === 'blank-claims-token') {
    return {
      oid: 'blank-claims-oid',
      name: '   ',
      preferred_username: ' ',
      upn: '\t',
    };
  }
  if (token === 'unprovisionable-token') return { oid: 'unprovisionable-oid' };
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

test('requires a verified token and provisions a first-time caller', async () => {
  assert.equal((await request('/api/lnbits/users')).status, 401);
  assert.equal((await request('/api/lnbits/users', { token: 'nope' })).status, 401);
  // An unverified caller must never reach provisioning.
  assert.equal(ensureCalls.length, 0);

  const firstRun = await request('/api/lnbits/users', {
    token: 'unlinked-token',
  });
  assert.equal(firstRun.status, 200);
  assert.deepEqual(ensureCalls.at(-1), {
    aadObjectId: 'unlinked-oid',
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
    userPrincipalName: 'ada@example.com',
  });

  const response = await request('/api/lnbits/users', { token: 'valid-token' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id: 'user-1' }]);
});

test('whitespace-only claims never reach provisioning as a value', async () => {
  const response = await request('/api/lnbits/users', {
    token: 'blank-claims-token',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(ensureCalls.at(-1), {
    aadObjectId: 'blank-claims-oid',
    displayName: '',
    email: '',
    userPrincipalName: '',
  });
});

test('a failed provisioning explains itself instead of masking a 5xx', async () => {
  const response = await request('/api/lnbits/users', {
    token: 'unprovisionable-token',
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'We could not create your Zaplie wallet yet — try again',
  });
});

test('repairs the caller own half-provisioned account, and only theirs', async () => {
  // ensureCaller short-circuits for an already linked user, so this listing is
  // where a missing wallet is actually noticed.
  const own = await request('/api/lnbits/users/user-1/wallets', {
    token: 'valid-token',
  });
  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), [
    { id: 'user-1-private', name: 'Private' },
    { id: 'user-1-allowance', name: 'Allowance' },
  ]);
  assert.deepEqual(calls.slice(-2), [
    ['wallets', 'user-1'],
    ['repair', 'user-1'],
  ]);

  const other = await request('/api/lnbits/users/user-2/wallets', {
    token: 'valid-token',
  });
  assert.deepEqual(await other.json(), [
    { id: 'user-2-private', name: 'Private' },
  ]);
  // Somebody else's account is never touched by the caller's request.
  assert.deepEqual(calls.at(-1), ['wallets', 'user-2']);
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
