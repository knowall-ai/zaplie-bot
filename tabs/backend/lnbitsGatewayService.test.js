const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  createInvoice,
  createSendZap,
  getAllPayments,
  getNostrRewards,
  getWalletBalance,
  listDirectoryUsers,
  listUsers,
  listUserWallets,
  maxZapAmountSats,
  listWalletPayments,
  redactSensitive,
  resetCachesForTests,
  sanitizePayment,
  sanitizeWallet,
  sanitizeBalanceMsat,
  zapExtra,
} = require('./lnbitsGatewayService');
const { resetPeopleStoreForTests, peopleStore } = require('./peopleStore');
const {
  createZapIdempotencyStore,
} = require('./lnbitsZapIdempotencyStore');

const OID_1 = '00000000-0000-4000-8000-000000000001';
const OID_2 = '00000000-0000-4000-8000-000000000002';
const KEY = (n) => String(n).repeat(32).slice(0, 32);

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

// A temporary people directory with two people, each with an Allowance
// wallet under zaplie.service. No LNbits login or Users API exists any more,
// so the stub refuses both outright.
const installLnbitsStub = ({ token = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-gateway-'));
  process.env.ZAPLIE_DATA_DIR = dir;
  process.env.ZAPLIE_STORE_KEY = 'a'.repeat(64);
  process.env.LNBITS_URL = 'https://lnbits.test';
  if (token) process.env.LNBITS_API_TOKEN = 'test-token';
  else delete process.env.LNBITS_API_TOKEN;
  resetPeopleStoreForTests();
  resetCachesForTests();
  const store = peopleStore();
  for (const [oid, name, n] of [[OID_1, 'Ada', 1], [OID_2, 'Bea', 2]]) {
    store.upsertProfile({ oid, displayName: name });
    store.setAllowanceWallet(oid, {
      walletId: `wallet-${n}`,
      adminkey: KEY(`a${n}`),
      inkey: KEY(`i${n}`),
      source: 'token',
    });
  }

  const calls = [];
  global.fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    calls.push({ pathname, headers: init.headers || {} });
    if (pathname.startsWith('/users/api') || pathname === '/api/v1/auth') {
      throw new Error(`forbidden LNbits path ${pathname}`);
    }
    if (pathname === '/api/v1/wallet') {
      return jsonResponse({ balance: 5000 });
    }
    if (pathname === '/api/v1/wallets') {
      return jsonResponse([
        { id: 'wallet-1', balance_msat: 7000, inkey: KEY('i1'), adminkey: KEY('a1') },
      ]);
    }
    if (pathname === '/api/v1/payments') {
      return jsonResponse([]);
    }
    if (pathname === '/api/v1/payments/all/paginated') {
      return jsonResponse({ data: [], total: 0 });
    }
    throw new Error(`unexpected LNbits path ${pathname}`);
  };
  return calls;
};

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

test('a wallet read is refused when the wallet belongs to somebody else', async () => {
  installLnbitsStub();

  await assert.rejects(getWalletBalance('wallet-2', OID_1), {
    message: 'Wallet does not belong to this account',
    status: 403,
  });
  assert.equal(await getWalletBalance('wallet-1', OID_1), 5);
});

test('nobody outside the directory reaches a wallet', async () => {
  installLnbitsStub();
  await assert.rejects(
    getWalletBalance('wallet-1', '00000000-0000-4000-8000-0000000000ff'),
    (error) => error.status === 403,
  );
});

test('directory reads never call the LNbits Users API or log in', async () => {
  const calls = installLnbitsStub();

  const users = await listUsers();
  assert.deepEqual(users.map((user) => user.id), [OID_1, OID_2]);
  assert.equal(users[0].aadObjectId, OID_1);
  const wallets = await listUserWallets(OID_1);
  assert.deepEqual(wallets, [
    { id: 'wallet-1', name: 'Allowance', user: OID_1, balance_msat: 5000, deleted: false },
  ]);
  await listWalletPayments('wallet-2');

  assert.ok(calls.every((call) => call.headers['X-Api-Key']));
  assert.ok(calls.every((call) => !call.headers.Authorization));
});

test('the allowance sync sees one complete entry per person, keyed by Entra id', async () => {
  installLnbitsStub();
  const listed = await listDirectoryUsers();
  assert.equal(listed.complete, true);
  assert.deepEqual(
    listed.users.map((user) => [user.external_id, user.extra.display_name]),
    [[OID_1, 'Ada'], [OID_2, 'Bea']],
  );
});

test('with the API token, balances come from one account-level read', async () => {
  const calls = installLnbitsStub({ token: true });
  const wallets = await listUserWallets(OID_1);
  assert.equal(wallets[0].balance_msat, 7000);
  const tokenCalls = calls.filter((call) => call.headers.Authorization);
  assert.deepEqual(tokenCalls.map((call) => call.pathname), ['/api/v1/wallets']);
  assert.equal(tokenCalls[0].headers.Authorization, 'Bearer test-token');
  delete process.env.LNBITS_API_TOKEN;
});

test('all payments use the token when configured and merge wallet pages without it', async () => {
  let calls = installLnbitsStub({ token: true });
  await getAllPayments({ limit: 10 });
  assert.deepEqual(
    calls.map((call) => call.pathname),
    ['/api/v1/payments/all/paginated'],
  );

  calls = installLnbitsStub();
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const key = init.headers['X-Api-Key'];
    if (new URL(url).pathname === '/api/v1/payments') {
      return jsonResponse(
        key === KEY('i1')
          ? [{ checking_id: 'a', amount: -1000, time: 10, wallet_id: 'wallet-1' }]
          : [{ checking_id: 'b', amount: -2000, time: 20, wallet_id: 'wallet-2' }],
      );
    }
    return original(url, init);
  };
  const merged = await getAllPayments({ limit: 10 });
  assert.deepEqual(merged.map((payment) => payment.checking_id), ['b', 'a']);
});

test('the rewards store is off by default and an absent nostrmarket reads as empty', async (t) => {
  installLnbitsStub();
  t.after(() => {
    delete process.env.ZAPLIE_REWARDS_STORE_ENABLED;
    delete process.env.ZAPLIE_TREASURY_INKEY;
  });
  global.fetch = async () => {
    throw new Error('the store must not be called while disabled');
  };
  assert.deepEqual(await getNostrRewards('stall-1'), []);

  process.env.ZAPLIE_REWARDS_STORE_ENABLED = 'true';
  process.env.ZAPLIE_TREASURY_INKEY = KEY('t');
  global.fetch = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => 'application/json' },
    json: async () => ({ detail: 'Not Found' }),
  });
  assert.deepEqual(await getNostrRewards('stall-1'), []);
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

test('an unusable payment hash is omitted rather than exposed', () => {
  for (const payment_hash of ['', 'x'.repeat(257), 42, null]) {
    const payment = sanitizePayment({ checking_id: 'checking-1', payment_hash });
    assert.equal(payment.payment_hash, undefined);
    assert.equal(payment.checking_id, 'checking-1');
    assert.ok(!('payment_hash' in JSON.parse(JSON.stringify(payment))));
  }
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

test('one unidentifiable row is dropped, not the whole payments page', async (t) => {
  installLnbitsStub();
  const upstream = global.fetch;
  global.fetch = async (url, init) => {
    if (new URL(url).pathname === '/api/v1/payments') {
      return jsonResponse([
        { checking_id: 'good-1', amount: -10, time: 1, wallet_id: 'wallet-1' },
        // No checking_id, payment_hash or id: LNbits cannot identify this row.
        { amount: -20, time: 2, wallet_id: 'wallet-1', memo: 'private note' },
        { payment_hash: 'good-2', amount: 30, time: 3, wallet_id: 'wallet-1' },
      ]);
    }
    return upstream(url, init);
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  const payments = await listWalletPayments('wallet-1');

  assert.deepEqual(
    payments.map((payment) => payment.checking_id),
    ['good-1', 'good-2'],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing a stable identifier/);
  assert.match(warnings[0], /wallet_id=wallet-1/);
  assert.match(warnings[0], /time=2/);
  // The dropped record's own content must not reach the log.
  assert.ok(!warnings[0].includes('private note'));
});

test('invoice creation returns the exact stable invoice identifier', async (t) => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.LNBITS_URL;
  process.env.LNBITS_URL = 'https://lnbits.test';
  t.after(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.LNBITS_URL;
    else process.env.LNBITS_URL = originalUrl;
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

  global.fetch = async () => ({
    ok: true,
    status: 201,
    headers: { get: () => 'application/json' },
    json: async () => ({
      payment_request: 'lnbc1invoice',
      checking_id: 'x'.repeat(257),
      payment_hash: 'invoice-2',
    }),
  });

  assert.deepEqual(
    await createInvoice({ inkey: 'invoice-key' }, 20, 'thank you'),
    { paymentRequest: 'lnbc1invoice', invoiceId: 'invoice-2' },
  );
});

const SENDER = {
  oid: '00000000-0000-4000-8000-00000000000a',
  displayName: 'Sender',
  allowance: { walletId: 'allowance-1', adminkey: 'ad', inkey: 'in' },
};
const RECIPIENT = {
  oid: '00000000-0000-4000-8000-00000000000b',
  displayName: 'Recipient',
  receive: { lightningAddress: 'recipient@lnbits.test' },
};

const createTestZapDependencies = (store, onPay = async () => ({
  payment_hash: 'payment-1',
  checking_id: 'payment-1',
})) => ({
  findCallerForZap: async () => SENDER,
  findRecipientForZap: async (oid) => (oid === RECIPIENT.oid ? RECIPIENT : null),
  getBalanceForZap: async () => 100,
  createInvoiceForZap: async () => ({
    paymentRequest: 'lnbc1invoice',
    invoiceId: 'invoice-1',
  }),
  payInvoiceForZap: onPay,
  idempotencyStore: store,
});

const validZap = {
  recipientUserId: RECIPIENT.oid,
  amount: 20,
  memo: 'thank you',
  aadObjectId: 'caller-oid',
  idempotencyKey: 'zap-request-00000001',
};

test('self-zaps are rejected before an invoice or payment is created', async () => {
  let invoiceCalls = 0;
  let paymentCalls = 0;
  const sendZap = createSendZap({
    findCallerForZap: async () => SENDER,
    findRecipientForZap: async () => SENDER,
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
    sendZap({ ...validZap, recipientUserId: SENDER.oid.toUpperCase() }),
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
      return SENDER;
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

// A store that pays fine but cannot record the success: the crash path that
// used to be swallowed, leaving the record pending and every retry wedged.
const createBrokenCompleteStore = (storePath) => {
  const store = createZapIdempotencyStore({ storePath });
  return {
    ...store,
    complete: async () => {
      throw new Error('disk full');
    },
  };
};

test('a zap whose success cannot be recorded is reported, not swallowed', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-zap-unknown-'));
  const storePath = path.join(tempDir, 'zaps.json');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let paymentCalls = 0;

  const sendZap = createSendZap(
    createTestZapDependencies(createBrokenCompleteStore(storePath), async () => {
      paymentCalls += 1;
      return { payment_hash: 'payment-1', checking_id: 'payment-1' };
    }),
  );

  await assert.rejects(
    sendZap(validZap),
    (error) => error.status === 503 && /contact support/.test(error.message),
  );
  assert.equal(paymentCalls, 1);

  const record = Object.values(
    JSON.parse(fs.readFileSync(storePath, 'utf8')).records,
  )[0];
  assert.equal(record.state, 'outcome_unknown');
  // The identifiers are what makes it reconcilable against LNbits.
  assert.equal(record.payment.invoiceId, 'invoice-1');
  assert.equal(record.payment.paymentHash, 'payment-1');

  // A retry must not pay again, and must say the same thing.
  await assert.rejects(
    sendZap(validZap),
    (error) => error.status === 503 && /contact support/.test(error.message),
  );
  assert.equal(paymentCalls, 1);
});

test('a poisoned key keeps the invoice id needed to reconcile it', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-zap-invoice-'));
  const storePath = path.join(tempDir, 'zaps.json');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sendZap = createSendZap(
    createTestZapDependencies(
      createZapIdempotencyStore({ storePath }),
      async () => {
        throw new Error('LNbits timed out mid-payment');
      },
    ),
  );

  await assert.rejects(sendZap(validZap), /timed out/);

  const record = Object.values(
    JSON.parse(fs.readFileSync(storePath, 'utf8')).records,
  )[0];
  assert.equal(record.state, 'failed');
  assert.equal(record.payment.invoiceId, 'invoice-1');
});

test('a zap that cannot even be marked unknown is never recorded as failed', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-zap-mark-fail-'));
  const storePath = path.join(tempDir, 'zaps.json');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inner = createZapIdempotencyStore({ storePath });
  let failCalls = 0;

  // Both the success write and the fallback write fail, the worst case.
  const store = {
    ...inner,
    complete: async () => {
      throw new Error('disk full');
    },
    markOutcomeUnknown: async () => {
      throw new Error('still disk full');
    },
    fail: async (args) => {
      failCalls += 1;
      return inner.fail(args);
    },
  };

  const sendZap = createSendZap(createTestZapDependencies(store));

  await assert.rejects(
    sendZap(validZap),
    (error) => error.status === 503 && /contact support/.test(error.message),
  );

  // `failed` would read as "not paid" and replay as "cannot be retried
  // safely", but the money has gone. The record must not say that.
  assert.equal(failCalls, 0);
  const record = Object.values(
    JSON.parse(fs.readFileSync(storePath, 'utf8')).records,
  )[0];
  assert.equal(record.state, 'pending');
  assert.equal(record.payment.invoiceId, 'invoice-1');
});

// Both cap variables are process-wide, so each case sets exactly the state it
// describes and restores whatever the parent process had. Deleting an inherited
// value would silently change every case that runs after it.
const CAP_VARS = ['ZAP_MAX_AMOUNT_SATS', 'REWARDS_MAX_AMOUNT_SATS'];

const withCaps = (caps, assertions) => {
  const original = CAP_VARS.map((name) => [name, process.env[name]]);
  try {
    for (const name of CAP_VARS) {
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(caps)) {
      process.env[name] = value;
    }
    assertions();
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

test('with neither cap configured the zap ceiling is 1,000,000', () => {
  withCaps({}, () => assert.equal(maxZapAmountSats(), 1_000_000));
});

// Giving zaps their own variable must not loosen a deployment that never asked
// for it: env/.env.dev.example ships REWARDS_MAX_AMOUNT_SATS=10000, which caps
// zaps today, so such a deployment keeps its 10,000-sat ceiling until it names
// a zap cap of its own.
test('an unset zap cap inherits the configured reward cap', () => {
  withCaps({ REWARDS_MAX_AMOUNT_SATS: '10000' }, () =>
    assert.equal(maxZapAmountSats(), 10000),
  );
});

test('ZAP_MAX_AMOUNT_SATS takes precedence, above or below the reward cap', () => {
  withCaps({ REWARDS_MAX_AMOUNT_SATS: '10000', ZAP_MAX_AMOUNT_SATS: '500' }, () =>
    assert.equal(maxZapAmountSats(), 500),
  );
  withCaps({ REWARDS_MAX_AMOUNT_SATS: '10000', ZAP_MAX_AMOUNT_SATS: '50000' }, () =>
    assert.equal(maxZapAmountSats(), 50000),
  );
});

test('a whitespace-only cap is unset, not malformed', () => {
  withCaps({ ZAP_MAX_AMOUNT_SATS: '   ', REWARDS_MAX_AMOUNT_SATS: '10000' }, () =>
    assert.equal(maxZapAmountSats(), 10000),
  );
});

test('a malformed cap fails closed rather than widening the ceiling', () => {
  // Number() would have read 1e3 and 0x10 as caps nobody typed, and a bare
  // fallback would have silently restored the 1,000,000 default.
  for (const malformed of ['not-a-number', '-1', '0', '1.5', '0x10', '1e3']) {
    withCaps({ ZAP_MAX_AMOUNT_SATS: malformed }, () => {
      assert.throws(maxZapAmountSats, {
        message: 'ZAP_MAX_AMOUNT_SATS must be a positive integer',
        status: 503,
      });
    });
    withCaps({ REWARDS_MAX_AMOUNT_SATS: malformed }, () => {
      assert.throws(maxZapAmountSats, {
        message: 'REWARDS_MAX_AMOUNT_SATS must be a positive integer',
        status: 503,
      });
    });
  }
});

test('an unreadable wallet balance is null, not a fabricated zero', () => {
  // `Number(wallet.balance_msat || 0)` used to send a confident 0 to the
  // browser for a missing, null or unparseable balance, which then satisfied
  // every client-side isFinite guard.
  for (const balance of [undefined, null, '', '  ', 'not-a-number', NaN]) {
    const result = sanitizeWallet({
      id: 'wallet-1',
      name: 'Private',
      user: 'user-1',
      balance_msat: balance,
      deleted: false,
    });
    assert.equal(result.balance_msat, null, `balance ${String(balance)}`);
  }
});

test('numeric wallet balances survive sanitisation, strings included', () => {
  assert.equal(sanitizeBalanceMsat(0), 0);
  assert.equal(sanitizeBalanceMsat(42000), 42000);
  assert.equal(sanitizeBalanceMsat(-1000), -1000);
  assert.equal(sanitizeBalanceMsat('42000'), 42000);
});

test('zap metadata names both people and never carries a key', () => {
  const extra = zapExtra(SENDER, { id: 'allowance-1', adminkey: 'ad', inkey: 'in' }, RECIPIENT);
  assert.deepEqual(extra, {
    tag: 'zap',
    from: { id: 'allowance-1', name: 'Allowance', user: SENDER.oid, displayName: 'Sender' },
    to: { name: 'Private', user: RECIPIENT.oid, displayName: 'Recipient' },
  });
  assert.deepEqual(redactSensitive(extra), extra);
});

test('the zap pays the recipient invoice from the sender Allowance, with metadata', async () => {
  const paid = [];
  const sendZap = createSendZap({
    ...createTestZapDependencies(
      createZapIdempotencyStore({
        storePath: path.join(os.tmpdir(), `zaplie-zap-meta-${process.pid}.json`),
      }),
      async (wallet, paymentRequest, extra) => {
        paid.push({ wallet, paymentRequest, extra });
        return { payment_hash: 'payment-1', checking_id: 'payment-1' };
      },
    ),
  });
  await sendZap({ ...validZap, idempotencyKey: `zap-meta-${Date.now()}-0001` });
  assert.equal(paid.length, 1);
  assert.equal(paid[0].wallet.adminkey, 'ad');
  assert.equal(paid[0].extra.to.user, RECIPIENT.oid);
});

test('an unregistered recipient is refused before any invoice', async () => {
  let invoices = 0;
  const sendZap = createSendZap({
    ...createTestZapDependencies(createZapIdempotencyStore({
      storePath: path.join(os.tmpdir(), `zaplie-zap-unknown-${process.pid}.json`),
    })),
    findRecipientForZap: async () => null,
    createInvoiceForZap: async () => {
      invoices += 1;
      return { paymentRequest: 'lnbc1invoice' };
    },
  });
  await assert.rejects(
    sendZap({ ...validZap, idempotencyKey: `zap-unknown-${Date.now()}-01` }),
    (error) => error.status === 409,
  );
  assert.equal(invoices, 0);
});
