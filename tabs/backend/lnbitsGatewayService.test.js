const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  createOwnedInvoice,
  createPayReward,
  createSendZap,
  getAllPayments,
  getNostrRewards,
  getWalletBalance,
  listDirectoryUsers,
  listUsers,
  listUserWallets,
  maxZapAmountSats,
  listWalletPayments,
  payOwnedInvoice,
  redactSensitive,
  resetCachesForTests,
  sanitizePayment,
  sanitizeWallet,
  sanitizeBalanceMsat,
} = require('./lnbitsGatewayService');
const { resetPeopleStoreForTests, peopleStore } = require('./peopleStore');
const { NwcPaymentRefused, setNwcWalletsForTests } = require('./nwcWallet');
const { resetZapRecordsForTests, zapRecords } = require('./zapRecordStore');
const { createFakeNwc, nwcUrlFor } = require('./testSupport/fakeNwc');
const {
  createZapIdempotencyStore,
} = require('./lnbitsZapIdempotencyStore');

const OID_1 = '00000000-0000-4000-8000-000000000001';
const OID_2 = '00000000-0000-4000-8000-000000000002';

// A temporary directory of two people whose Allowance wallets sit behind a
// fake NWC wallet service. No LNbits HTTP call is expected at all: fetch
// refuses every request.
const installLnbitsStub = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-gateway-'));
  process.env.ZAPLIE_DATA_DIR = dir;
  process.env.ZAPLIE_STORE_KEY = 'a'.repeat(64);
  process.env.LNBITS_URL = 'https://bank.example';
  resetPeopleStoreForTests();
  resetZapRecordsForTests();
  resetCachesForTests();
  const fake = createFakeNwc();
  setNwcWalletsForTests(fake.factory);
  const store = peopleStore();
  const ids = {};
  for (const [oid, name, n] of [[OID_1, 'Ada', 1], [OID_2, 'Bea', 2]]) {
    fake.add(nwcUrlFor(n), { balanceSats: 5 * n });
    store.upsertProfile({ oid, displayName: name });
    store.setAllowanceWallet(oid, {
      walletId: `wallet-${n}`,
      nwc: nwcUrlFor(n),
      lightningAddress: `zaplie-${n}@bank.example`,
      source: 'operator',
    });
    ids[oid] = `wallet-${n}`;
  }
  const http = [];
  global.fetch = async (url) => {
    http.push(String(url));
    throw new Error(`no HTTP expected: ${url}`);
  };
  return { fake, http, store };
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

test('an Allowance wallet never pays an arbitrary invoice', async () => {
  const { fake } = installLnbitsStub();
  const pay = (walletId) =>
    payOwnedInvoice({ walletId, paymentRequest: 'lnbc10n1anything', aadObjectId: OID_1 });
  await assert.rejects(pay('wallet-1'), (error) => error.status === 403 && /only be sent as zaps/.test(error.message));
  await assert.rejects(pay('wallet-2'), /does not belong/);
  assert.equal(fake.calls.filter((call) => call.method === 'pay_invoice').length, 0);
});

test('nobody outside the directory reaches a wallet', async () => {
  installLnbitsStub();
  await assert.rejects(
    getWalletBalance('wallet-1', '00000000-0000-4000-8000-0000000000ff'),
    (error) => error.status === 403,
  );
});

test('directory reads go over NWC and never make an LNbits HTTP call', async () => {
  const { fake, http } = installLnbitsStub();

  const users = await listUsers();
  assert.deepEqual(users.map((user) => user.id), [OID_1, OID_2]);
  assert.equal(users[0].aadObjectId, OID_1);
  assert.deepEqual(await listUserWallets(OID_1), [
    { id: 'wallet-1', name: 'Allowance', user: OID_1, balance_msat: 5000, deleted: false },
  ]);
  assert.deepEqual(http, []);
  assert.ok(fake.calls.every((call) => call.method === 'get_balance'));
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

test('wallet history comes from NWC, with Zaplie\'s record of each zap as extra', async () => {
  const { fake } = installLnbitsStub();
  const hash = 'ab'.repeat(32);
  fake.wallets.get(nwcUrlFor(1)).transactions = [
    { type: 'outgoing', state: 'settled', payment_hash: hash, amount: 21000, fees_paid: 0, description: 'raw', created_at: 100 },
    { type: 'incoming', state: 'settled', payment_hash: 'cd'.repeat(32), amount: 5000, fees_paid: 0, description: 'Weekly allowance', created_at: 90 },
    { type: 'outgoing', state: 'failed', payment_hash: 'ef'.repeat(32), amount: 1000, created_at: 80 },
  ];
  zapRecords().record({
    paymentHash: hash,
    amountSats: 21,
    memo: 'thanks',
    from: { oid: OID_1, displayName: 'Ada', walletId: 'wallet-1' },
    to: { oid: OID_2, displayName: 'Bea' },
  });

  const payments = await listWalletPayments('wallet-1');
  assert.deepEqual(
    payments.map((payment) => [payment.checking_id, payment.amount, payment.memo]),
    [[hash, -21000, 'thanks'], ['cd'.repeat(32), 5000, 'Weekly allowance']],
  );
  assert.equal(payments[0].extra.to.user, OID_2);
  assert.equal(payments[0].wallet_id, 'wallet-1');
  assert.deepEqual(payments[1].extra, {});
});

test('the feed is Zaplie\'s zap records as sending legs', async () => {
  installLnbitsStub();
  zapRecords().record({ paymentHash: '11'.repeat(32), amountSats: 3, memo: 'a', timeMs: 1000, from: { oid: OID_1, displayName: 'Ada', walletId: 'wallet-1' }, to: { oid: OID_2, displayName: 'Bea' } });
  zapRecords().record({ paymentHash: '22'.repeat(32), kind: 'reward', amountSats: 7, memo: 'PR', timeMs: 2000, from: { displayName: 'Automation' }, to: { oid: OID_1, displayName: 'Ada' }, reward: { eventType: 'githubPrMerged' } });
  const payments = await getAllPayments({ limit: 10 });
  assert.deepEqual(payments.map((p) => [p.amount, p.wallet_id]), [[-7000, 'treasury'], [-3000, 'wallet-1']]);
  assert.equal(payments[0].extra.automation, true);
  assert.equal(payments[0].extra.eventType, 'githubPrMerged');
  assert.equal(payments[1].extra.tag, 'zap');
});

test('the rewards store is off by default and an absent nostrmarket reads as empty', async (t) => {
  installLnbitsStub();
  t.after(() => {
    delete process.env.ZAPLIE_REWARDS_STORE_ENABLED;
    delete process.env.ZAPLIE_REWARDS_STORE_INKEY;
  });
  assert.deepEqual(await getNostrRewards('stall-1'), []);

  process.env.ZAPLIE_REWARDS_STORE_ENABLED = 'true';
  process.env.ZAPLIE_REWARDS_STORE_INKEY = 'f'.repeat(32);
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

test('one unidentifiable row is dropped, not the whole history', async (t) => {
  const { fake } = installLnbitsStub();
  fake.wallets.get(nwcUrlFor(1)).transactions = [
    { type: 'outgoing', state: 'settled', payment_hash: 'aa'.repeat(32), amount: 1000, created_at: 1 },
    { type: 'outgoing', state: 'settled', amount: 2000, created_at: 2, description: 'private note' },
  ];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  const payments = await listWalletPayments('wallet-1');
  assert.deepEqual(payments.map((payment) => payment.checking_id), ['aa'.repeat(32)]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing a stable identifier/);
  assert.ok(!warnings[0].includes('private note'));
});

test('an invoice on the caller\'s own Allowance wallet is made over NWC', async () => {
  const { fake } = installLnbitsStub();
  const invoice = await createOwnedInvoice({ walletId: 'wallet-1', amount: 20, memo: 'top up', aadObjectId: OID_1 });
  assert.match(invoice.paymentRequest, /^lnbc/);
  assert.match(invoice.invoiceId, /^[0-9a-f]{64}$/);
  assert.deepEqual(fake.calls.at(-1).params, { amount: 20000, description: 'top up' });
  await assert.rejects(
    createOwnedInvoice({ walletId: 'wallet-2', amount: 20, memo: 'x', aadObjectId: OID_1 }),
    (error) => error.status === 403,
  );
});

const SENDER = {
  oid: '00000000-0000-4000-8000-00000000000a',
  displayName: 'Sender',
  allowance: { walletId: 'allowance-1' },
};
const RECIPIENT = {
  oid: '00000000-0000-4000-8000-00000000000b',
  displayName: 'Recipient',
  receive: { lightningAddress: 'recipient@lnbits.test' },
};

// `onPay` answers like the old LNbits pay call; the fake NWC wallet turns its
// payment_hash into the adapter's { paymentHash }.
const createTestZapDependencies = (
  store,
  onPay = async () => ({ payment_hash: 'payment-1', checking_id: 'payment-1' }),
  { balance = () => 100, recorded = [] } = {},
) => ({
  findCallerForZap: async () => SENDER,
  findRecipientForZap: async (oid) => (oid === RECIPIENT.oid ? RECIPIENT : null),
  walletForZap: () => ({
    getBalanceSats: async () => balance(),
    payInvoice: async (paymentRequest) => {
      const result = await onPay(paymentRequest);
      return { paymentHash: result.payment_hash, feesSats: 0 };
    },
  }),
  createInvoiceForZap: async () => ({
    paymentRequest: 'lnbc1invoice',
    invoiceId: 'invoice-1',
  }),
  recordZap: (entry) => recorded.push(entry),
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
    ...createTestZapDependencies(
      createZapIdempotencyStore({
        storePath: path.join(os.tmpdir(), `zaplie-self-zap-${process.pid}.json`),
      }),
      async () => {
        paymentCalls += 1;
        return { payment_hash: 'payment-1' };
      },
    ),
    findRecipientForZap: async () => SENDER,
    createInvoiceForZap: async () => {
      invoiceCalls += 1;
      return { paymentRequest: 'lnbc1invoice', invoiceId: 'invoice-1' };
    },
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
  const sendZap = createSendZap(
    createTestZapDependencies(
      createZapIdempotencyStore({ storePath }),
      async () => {
        paymentCalls += 1;
        return { payment_hash: 'payment-1', checking_id: 'payment-1' };
      },
      { balance: () => balance },
    ),
  );

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

test('a paid zap is recorded once, by payment hash, naming both people', async () => {
  const recorded = [];
  const paid = [];
  const sendZap = createSendZap(
    createTestZapDependencies(
      createZapIdempotencyStore({
        storePath: path.join(os.tmpdir(), `zaplie-zap-meta-${process.pid}-${Date.now()}.json`),
      }),
      async (paymentRequest) => {
        paid.push(paymentRequest);
        return { payment_hash: 'ab'.repeat(32) };
      },
      { recorded },
    ),
  );
  const result = await sendZap({ ...validZap, idempotencyKey: `zap-meta-${Date.now()}-0001`, source: 'bot' });
  assert.deepEqual(result, { payment_hash: 'ab'.repeat(32), checking_id: 'ab'.repeat(32) });
  assert.deepEqual(paid, ['lnbc1invoice']);
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    { from: recorded[0].from, to: recorded[0].to, source: recorded[0].source, kind: recorded[0].kind },
    {
      from: { oid: SENDER.oid, displayName: 'Sender', walletId: 'allowance-1' },
      to: { oid: RECIPIENT.oid, displayName: 'Recipient' },
      source: 'bot',
      kind: 'zap',
    },
  );
});

// Ben's rule: an Allowance wallet pays only another Zaplie member, resolved
// here from the directory; nothing the client sends is ever paid.
test('a zap to someone outside the directory, or to an address or invoice, is refused before any payment', async () => {
  let invoices = 0;
  let pays = 0;
  const sendZap = createSendZap({
    ...createTestZapDependencies(
      createZapIdempotencyStore({
        storePath: path.join(os.tmpdir(), `zaplie-zap-unknown-${process.pid}-${Date.now()}.json`),
      }),
      async () => {
        pays += 1;
        return { payment_hash: 'payment-1' };
      },
    ),
    findRecipientForZap: async () => null,
    createInvoiceForZap: async () => {
      invoices += 1;
      return { paymentRequest: 'lnbc1invoice' };
    },
  });
  const key = (n) => `zap-refused-${Date.now()}-${n}0000`;
  await assert.rejects(sendZap({ ...validZap, idempotencyKey: key(1) }), (error) => error.status === 409 && error.paymentOutcome === 'not_paid');
  for (const [n, recipientUserId] of [[2, 'ada@wallet.other'], [3, 'lnbc10n1pexternalinvoice'], [4, '../admin']]) {
    await assert.rejects(
      sendZap({ ...validZap, recipientUserId, idempotencyKey: key(n) }),
      (error) => error.status === 400 && error.paymentOutcome === 'not_paid',
    );
  }
  assert.equal(invoices, 0);
  assert.equal(pays, 0);
});

test('a definite wallet refusal releases the key: nothing was paid', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-zap-refused-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let attempts = 0;
  const sendZap = createSendZap({
    ...createTestZapDependencies(createZapIdempotencyStore({ storePath: path.join(tempDir, 'zaps.json') })),
    walletForZap: () => ({
      getBalanceSats: async () => 100,
      payInvoice: async () => {
        attempts += 1;
        if (attempts === 1) throw new NwcPaymentRefused('The wallet budget for this period is used up.', 'QUOTA_EXCEEDED');
        return { paymentHash: 'cd'.repeat(32) };
      },
    }),
  });
  await assert.rejects(
    sendZap(validZap),
    (error) => error.status === 409 && error.expose && /budget/.test(error.message) && error.paymentOutcome === 'not_paid',
  );
  const retried = await sendZap(validZap);
  assert.equal(retried.payment_hash, 'cd'.repeat(32));
});

test('a reward is paid from the Treasury only to a directory member, and recorded', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-reward-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const recorded = [];
  const paidFrom = [];
  const payReward = createPayReward({
    findRecipient: async (oid) => (oid === RECIPIENT.oid ? RECIPIENT : null),
    treasuryWallet: () => ({
      payInvoice: async (paymentRequest) => {
        paidFrom.push(paymentRequest);
        return { paymentHash: 'ee'.repeat(32) };
      },
    }),
    createInvoiceForReward: async () => ({ paymentRequest: 'lnbc1reward' }),
    recordReward: (entry) => recorded.push(entry),
    idempotencyStore: createZapIdempotencyStore({ storePath: path.join(tempDir, 'zaps.json') }),
  });
  const reward = {
    recipientOid: RECIPIENT.oid,
    recipientLabel: 'octocat',
    amountSats: 50,
    memo: 'GitHub: PR #7 merged',
    reward: { eventType: 'githubPrMerged', repo: 'acme/api' },
    idempotencyKey: 'reward-delivery-0001',
  };
  assert.equal((await payReward(reward)).payment_hash, 'ee'.repeat(32));
  assert.equal((await payReward(reward)).payment_hash, 'ee'.repeat(32));
  assert.deepEqual(paidFrom, ['lnbc1reward']);
  assert.equal(recorded[0].kind, 'reward');
  assert.equal(recorded[0].to.displayName, 'octocat');

  await assert.rejects(
    payReward({ ...reward, recipientOid: '00000000-0000-4000-8000-0000000000ff', idempotencyKey: 'reward-delivery-0002' }),
    (error) => error.status === 409 && error.paymentOutcome === 'not_paid',
  );
  await assert.rejects(
    payReward({ ...reward, recipientOid: 'someone@wallet.other', idempotencyKey: 'reward-delivery-0003' }),
    (error) => error.status === 400,
  );
  assert.equal(paidFrom.length, 1);
});
