const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  createInvoice,
  createSendZap,
  redactSensitive,
  sanitizePayment,
  sanitizeWallet,
} = require('./lnbitsGatewayService');
const {
  createZapIdempotencyStore,
} = require('./lnbitsZapIdempotencyStore');

test('wallet serialization excludes LNbits invoice and admin keys', () => {
  const result = sanitizeWallet({
    id: 'wallet-1',
    name: 'Private',
    user: 'user-1',
    balance_msat: 1000,
    deleted: false,
    inkey: 'invoice-key-value',
    adminkey: 'admin-key-value',
  });

  assert.deepEqual(result, {
    id: 'wallet-1',
    name: 'Private',
    user: 'user-1',
    balance_msat: 1000,
    deleted: false,
  });
  assert.equal('inkey' in result, false);
  assert.equal('adminkey' in result, false);
});

test('nested upstream metadata is recursively stripped of sensitive fields', () => {
  const result = redactSensitive({
    public: 'ok',
    nested: {
      token: 'token-value',
      password: 'password-value',
      inkey: 'invoice-key-value',
      adminKey: 'admin-key-value',
      memo: 'visible',
    },
  });

  assert.deepEqual(result, { public: 'ok', nested: { memo: 'visible' } });
});

test('payments without the removed pending flag derive it from status', () => {
  const base = {
    checking_id: 'chk-1',
    payment_hash: 'hash-1',
    amount: -1000,
    fee: 0,
    memo: 'zap',
    time: 123,
    extra: {},
    wallet_id: 'wallet-1',
  };
  assert.equal(sanitizePayment({ ...base, status: 'success' }).pending, false);
  assert.equal(sanitizePayment({ ...base, status: 'pending' }).pending, true);
  assert.equal(sanitizePayment({ ...base, pending: true }).pending, true);
  assert.equal(sanitizePayment(base).pending, false);
});

test('payment serialization requires a stable identifier and preserves state', () => {
  const payment = sanitizePayment({
    checking_id: 'checking-1',
    payment_hash: 'hash-1',
    id: 'legacy-1',
    pending: true,
    amount: -20,
    fee: -1,
    memo: 'thank you',
    time: 123,
    wallet_id: 'wallet-1',
    extra: { adminkey: 'secret', recipientUserId: 'recipient-1' },
  });

  assert.deepEqual(payment, {
    checking_id: 'checking-1',
    payment_hash: 'hash-1',
    pending: true,
    amount: -20,
    fee: -1,
    memo: 'thank you',
    time: 123,
    wallet_id: 'wallet-1',
    extra: { recipientUserId: 'recipient-1' },
  });
});

test('payment serialization falls back to payment hash and legacy id', () => {
  assert.equal(
    sanitizePayment({ payment_hash: 'hash-1' }).checking_id,
    'hash-1',
  );
  assert.equal(sanitizePayment({ id: 'legacy-1' }).checking_id, 'legacy-1');
});

test('payment serialization rejects records without a stable identifier', () => {
  assert.throws(
    () => sanitizePayment({ amount: 20 }),
    /missing a stable identifier/,
  );
  assert.throws(
    () => sanitizePayment({ checking_id: 'x'.repeat(257) }),
    /missing a stable identifier/,
  );
});

test('invoice creation returns the exact stable invoice identifier', async (t) => {
  const originalFetch = global.fetch;
  const originalEnvironment = {
    nodeUrl: process.env.LNBITS_NODE_URL,
    username: process.env.LNBITS_USERNAME,
    password: process.env.LNBITS_PASSWORD,
  };
  process.env.LNBITS_NODE_URL = 'https://lnbits.test';
  process.env.LNBITS_USERNAME = 'test-user';
  process.env.LNBITS_PASSWORD = 'test-password';
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      LNBITS_NODE_URL: originalEnvironment.nodeUrl,
      LNBITS_USERNAME: originalEnvironment.username,
      LNBITS_PASSWORD: originalEnvironment.password,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  global.fetch = async (url, options) => {
    assert.equal(url, 'https://lnbits.test/api/v1/payments');
    assert.equal(options.headers['X-Api-Key'], 'invoice-key');
    assert.deepEqual(JSON.parse(options.body), {
      out: false,
      amount: 20,
      memo: 'thank you',
    });
    return {
      ok: true,
      status: 201,
      headers: { get: () => 'application/json' },
      json: async () => ({
        payment_request: 'lnbc1invoice',
        checking_id: 'invoice-1',
        adminkey: 'must-not-leak',
      }),
    };
  };

  assert.deepEqual(
    await createInvoice({ inkey: 'invoice-key' }, 20, 'thank you'),
    { paymentRequest: 'lnbc1invoice', invoiceId: 'invoice-1' },
  );
});

const createTestZapDependencies = (store, onPay = async () => ({
  payment_hash: 'payment-1',
  checking_id: 'payment-1',
})) => ({
  findCallerForZap: async () => ({ id: 'sender-1' }),
  listWalletsForZap: async (userId) => userId === 'sender-1'
    ? [{ id: 'allowance-1', name: 'Allowance' }]
    : [{ id: 'private-1', name: 'Private' }],
  getBalanceForZap: async () => 100,
  createInvoiceForZap: async () => ({
    paymentRequest: 'lnbc1invoice',
    invoiceId: 'invoice-1',
  }),
  payInvoiceForZap: onPay,
  idempotencyStore: store,
});

const validZap = {
  recipientUserId: 'recipient-1',
  amount: 20,
  memo: 'thank you',
  aadObjectId: 'caller-oid',
  idempotencyKey: 'zap-request-00000001',
};

test('self-zaps are rejected before an invoice or payment is created', async () => {
  let invoiceCalls = 0;
  let paymentCalls = 0;
  const sendZap = createSendZap({
    findCallerForZap: async () => ({ id: 'sender-1' }),
    listWalletsForZap: async () => [],
    getBalanceForZap: async () => 100,
    createInvoiceForZap: async () => {
      invoiceCalls += 1;
      return { paymentRequest: 'lnbc1invoice', invoiceId: 'invoice-1' };
    },
    payInvoiceForZap: async () => {
      paymentCalls += 1;
      return { payment_hash: 'payment-1', checking_id: 'payment-1' };
    },
    idempotencyStore: createZapIdempotencyStore({
      storePath: path.join(os.tmpdir(), `zaplie-self-zap-${process.pid}.json`),
    }),
  });

  await assert.rejects(
    sendZap({ ...validZap, recipientUserId: 'sender-1' }),
    (error) => error.status === 409 && /own account/.test(error.message),
  );
  assert.equal(invoiceCalls, 0);
  assert.equal(paymentCalls, 0);
});

test('duplicate idempotency keys pay once and replay after restart', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-zap-test-'));
  const storePath = path.join(tempDir, 'zaps.json');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const store = createZapIdempotencyStore({ storePath });
  let paymentCalls = 0;
  const pay = async () => {
    paymentCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { payment_hash: 'payment-1', checking_id: 'payment-1' };
  };
  const dependencies = createTestZapDependencies(store, pay);
  const sendZap = createSendZap(dependencies);

  const [first, concurrentRetry] = await Promise.all([
    sendZap(validZap),
    sendZap(validZap),
  ]);
  assert.deepEqual(first, concurrentRetry);
  assert.equal(paymentCalls, 1);

  const restartedSendZap = createSendZap(
    createTestZapDependencies(
      createZapIdempotencyStore({ storePath }),
      pay,
    ),
  );
  assert.deepEqual(await restartedSendZap(validZap), first);
  assert.equal(paymentCalls, 1);

  await assert.rejects(
    restartedSendZap({ ...validZap, amount: 21 }),
    (error) => error.status === 409 && /another zap/.test(error.message),
  );
  assert.equal(paymentCalls, 1);

  const stored = fs.readFileSync(storePath, 'utf8');
  assert.equal(stored.includes(validZap.aadObjectId), false);
  assert.equal(stored.includes(validZap.idempotencyKey), false);
  assert.equal(stored.includes(validZap.memo), false);
});

test('independent gateway instances cannot pay the same key twice', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-zap-race-'));
  const storePath = path.join(tempDir, 'zaps.json');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let paymentCalls = 0;
  const pay = async () => {
    paymentCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { payment_hash: 'payment-1', checking_id: 'payment-1' };
  };
  const firstGateway = createSendZap(
    createTestZapDependencies(
      createZapIdempotencyStore({ storePath }),
      pay,
    ),
  );
  const secondGateway = createSendZap(
    createTestZapDependencies(
      createZapIdempotencyStore({ storePath }),
      pay,
    ),
  );

  const attempts = await Promise.allSettled([
    firstGateway(validZap),
    secondGateway(validZap),
  ]);
  assert.equal(paymentCalls, 1);
  assert.equal(
    attempts.some((attempt) => attempt.status === 'fulfilled'),
    true,
  );
  for (const attempt of attempts.filter(({ status }) => status === 'rejected')) {
    assert.equal(attempt.reason.status, 409);
  }
});

test('a persisted pending key is blocked after a process restart', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-zap-pending-'));
  const storePath = path.join(tempDir, 'zaps.json');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const store = createZapIdempotencyStore({ storePath });
  const scope = store.scopeDigest(validZap);
  const requestHash = store.requestDigest(validZap);
  await store.begin({ scope, requestHash });
  let paymentCalls = 0;
  const sendZap = createSendZap(
    createTestZapDependencies(
      createZapIdempotencyStore({ storePath }),
      async () => {
        paymentCalls += 1;
        return { payment_hash: 'payment-1', checking_id: 'payment-1' };
      },
    ),
  );

  await assert.rejects(
    sendZap(validZap),
    (error) => error.status === 409 && /in progress/.test(error.message),
  );
  assert.equal(paymentCalls, 0);
});

test('gateway validates zap recipients and amounts without calling LNbits', async () => {
  let callerLookups = 0;
  const sendZap = createSendZap({
    ...createTestZapDependencies(createZapIdempotencyStore()),
    findCallerForZap: async () => {
      callerLookups += 1;
      return { id: 'sender-1' };
    },
  });

  await assert.rejects(
    sendZap({ ...validZap, recipientUserId: '../recipient' }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    sendZap({ ...validZap, amount: 1.5 }),
    (error) => error.status === 400,
  );
  assert.equal(callerLookups, 0);
});

test('failures before a payment attempt release the key for retry', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-zap-release-'));
  const storePath = path.join(tempDir, 'zaps.json');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let balance = 5;
  let paymentCalls = 0;
  const sendZap = createSendZap({
    ...createTestZapDependencies(
      createZapIdempotencyStore({ storePath }),
      async () => {
        paymentCalls += 1;
        return { payment_hash: 'payment-1', checking_id: 'payment-1' };
      },
    ),
    getBalanceForZap: async () => balance,
  });

  await assert.rejects(
    sendZap(validZap),
    (error) => error.status === 409 && /Insufficient/.test(error.message),
  );
  assert.equal(paymentCalls, 0);

  balance = 100;
  const result = await sendZap(validZap);
  assert.equal(result.payment_hash, 'payment-1');
  assert.equal(paymentCalls, 1);
});

test('failures after a payment attempt poison the key', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-zap-poison-'));
  const storePath = path.join(tempDir, 'zaps.json');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let paymentCalls = 0;
  const sendZap = createSendZap(
    createTestZapDependencies(
      createZapIdempotencyStore({ storePath }),
      async () => {
        paymentCalls += 1;
        throw new Error('LNbits timed out mid-payment');
      },
    ),
  );

  await assert.rejects(sendZap(validZap), /timed out/);
  assert.equal(paymentCalls, 1);

  await assert.rejects(
    sendZap(validZap),
    (error) => error.status === 409 && /cannot be retried safely/.test(error.message),
  );
  assert.equal(paymentCalls, 1);
});

test('a malformed zap amount cap fails instead of falling back', async (t) => {
  const original = process.env.REWARDS_MAX_AMOUNT_SATS;
  t.after(() => {
    if (original === undefined) delete process.env.REWARDS_MAX_AMOUNT_SATS;
    else process.env.REWARDS_MAX_AMOUNT_SATS = original;
  });
  process.env.REWARDS_MAX_AMOUNT_SATS = '500abc';

  const sendZap = createSendZap(
    createTestZapDependencies(createZapIdempotencyStore()),
  );
  await assert.rejects(sendZap(validZap), (error) => error.status === 503);
});
