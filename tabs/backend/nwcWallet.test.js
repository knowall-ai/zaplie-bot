const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');
const { NwcPaymentRefused, NwcPaymentUnknown, parseNwcUrl, paymentHashOf } = require('./nwcWallet');
const { FakeWalletError, createFakeNwc, nwcUrlFor } = require('./testSupport/fakeNwc');

const ENV = { LNBITS_URL: 'https://bank.example' };

test('a connection string is validated without being echoed back', () => {
  const url = nwcUrlFor(1);
  const parsed = parseNwcUrl(url, ENV);
  assert.match(parsed.connectionId, /^nwc_[0-9a-f]{24}$/);
  assert.deepEqual(parsed.relayUrls, ['wss://bank.example/nostrclient/api/v1/relay']);
  assert.equal(parseNwcUrl(url, ENV).connectionId, parsed.connectionId);
  assert.notEqual(parseNwcUrl(nwcUrlFor(2), ENV).connectionId, parsed.connectionId);

  const secret = new URL(url.replace('nostr+walletconnect://', 'http://')).searchParams.get('secret');
  for (const bad of [
    'https://example.com',
    url.replace(/secret=[0-9a-f]+/, 'secret=short'),
    url.replace(/relay=[^&]+/, 'relay=ws%3A%2F%2Fbank.example'),
    nwcUrlFor(1, 'wss://evil.example/relay'),
  ]) {
    assert.throws(
      () => parseNwcUrl(bad, ENV),
      (error) => error.status === 400 && error.expose && !error.message.includes(secret),
    );
  }
  assert.equal(parseNwcUrl(nwcUrlFor(1, 'wss://other.example/r'), { ...ENV, ZAPLIE_NWC_RELAYS: '*' }).relayUrls[0], 'wss://other.example/r');
});

test('verify requires every permission Zaplie uses', async () => {
  const fake = createFakeNwc();
  fake.add(nwcUrlFor(1), { balanceSats: 21, methods: ['get_info', 'get_balance', 'pay_invoice'] });
  await assert.rejects(fake.factory.verify(nwcUrlFor(1)), /lacks permissions Zaplie needs: make_invoice, lookup_invoice, list_transactions/);
  fake.add(nwcUrlFor(2), { balanceSats: 21 });
  const verified = await fake.factory.verify(nwcUrlFor(2));
  assert.equal(verified.balanceSats, 21);
});

test('a paid invoice yields the payment hash of the preimage', async () => {
  const fake = createFakeNwc();
  const preimage = 'ab'.repeat(32);
  fake.add(nwcUrlFor(1), { pay: async () => ({ preimage, fees_paid: 2000 }) });
  const paid = await fake.factory.open(nwcUrlFor(1)).payInvoice('lnbc10n1pinvoice');
  assert.equal(paid.paymentHash, crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex'));
  assert.equal(paid.paymentHash, paymentHashOf(preimage));
  assert.equal(paid.feesSats, 2);
});

test('a definite wallet refusal means nothing was paid', async () => {
  const fake = createFakeNwc();
  for (const [seed, code, text] of [
    [1, 'INSUFFICIENT_BALANCE', /enough sats/],
    [2, 'QUOTA_EXCEEDED', /budget for this period is used up/],
    [3, 'RESTRICTED', /not allowed/],
  ]) {
    fake.add(nwcUrlFor(seed), {
      pay: async () => {
        throw new FakeWalletError(code);
      },
    });
    await assert.rejects(
      fake.factory.open(nwcUrlFor(seed)).payInvoice('lnbc10n1p'),
      (error) => error instanceof NwcPaymentRefused && error.code === code && text.test(error.message),
    );
  }
});

test('no answer is resolved by looking the invoice up, else reported unknown', async () => {
  const fake = createFakeNwc();
  const hang = () => new Promise(() => {});
  const settled = fake.add(nwcUrlFor(1), { pay: hang });
  settled.lookup = async () => ({ state: 'settled', payment_hash: 'cd'.repeat(32), fees_paid: 0 });
  assert.equal((await fake.factory.open(nwcUrlFor(1)).payInvoice('lnbc10n1p')).paymentHash, 'cd'.repeat(32));

  const failed = fake.add(nwcUrlFor(2), { pay: hang });
  failed.lookup = async () => ({ state: 'failed' });
  await assert.rejects(fake.factory.open(nwcUrlFor(2)).payInvoice('lnbc10n1p'), NwcPaymentRefused);

  const pending = fake.add(nwcUrlFor(3), {
    pay: async () => {
      throw new FakeWalletError('INTERNAL');
    },
  });
  pending.lookup = async () => ({ state: 'pending' });
  await assert.rejects(fake.factory.open(nwcUrlFor(3)).payInvoice('lnbc10n1p'), NwcPaymentUnknown);
});

test('a timed-out read is an error and the next call uses a fresh client', async () => {
  const { createNwcWalletFactory, NwcError } = require('./nwcWallet');
  let created = 0;
  let closed = 0;
  const factory = createNwcWalletFactory({
    env: ENV,
    timeoutMs: 50,
    clientFactory: () => {
      created += 1;
      const first = created === 1;
      return {
        getBalance: () => (first ? new Promise(() => {}) : Promise.resolve({ balance: 7000 })),
        close: () => {
          closed += 1;
        },
      };
    },
  });
  const handle = factory.open(nwcUrlFor(1));
  await assert.rejects(handle.getBalanceSats(), (error) => error instanceof NwcError && error.code === 'TIMEOUT');
  assert.equal(closed, 1);
  assert.equal(await handle.getBalanceSats(), 7);
  assert.equal(created, 2);
});

test('budget is read only from a wallet that advertises get_budget', async () => {
  const fake = createFakeNwc();
  fake.add(nwcUrlFor(1), { budget: { used_budget: 4000, total_budget: 10000, renewal_period: 'weekly' } });
  const handle = fake.factory.open(nwcUrlFor(1));
  assert.equal(await handle.getBudget(['get_balance']), null);
  assert.deepEqual(await handle.getBudget(['get_budget']), {
    totalSats: 10,
    usedSats: 4,
    renewsAt: null,
    renewalPeriod: 'weekly',
  });
  assert.equal(fake.calls.filter((call) => call.method === 'get_budget').length, 1);
});

test('a placeholder preimage is never hashed: the wallet is asked which payment it was', async () => {
  const zeros = '0'.repeat(64);
  assert.equal(paymentHashOf(zeros), null);

  const fake = createFakeNwc();
  const first = fake.add(nwcUrlFor(1), { pay: async () => ({ preimage: zeros, fees_paid: 0 }) });
  first.lookup = async () => ({ state: 'settled', payment_hash: 'AB'.repeat(32), fees_paid: 1000 });
  const second = fake.add(nwcUrlFor(2), { pay: async () => ({ preimage: zeros, fees_paid: 0 }) });
  second.lookup = async () => ({ state: 'settled', payment_hash: 'cd'.repeat(32), fees_paid: 0 });
  const one = await fake.factory.open(nwcUrlFor(1)).payInvoice('lnbc10n1p');
  const two = await fake.factory.open(nwcUrlFor(2)).payInvoice('lnbc10n1q');
  assert.deepEqual(one, { paymentHash: 'ab'.repeat(32), feesSats: 1 });
  // Two payments without a preimage must not share one payment hash.
  assert.notEqual(one.paymentHash, two.paymentHash);

  // Paid, but the wallet cannot say which payment: unknown, never a made-up hash.
  fake.add(nwcUrlFor(3), { pay: async () => ({ preimage: zeros, fees_paid: 0 }) });
  await assert.rejects(fake.factory.open(nwcUrlFor(3)).payInvoice('lnbc10n1r'), NwcPaymentUnknown);
});

test('an SDK network error (named "Error", told apart by its class) drops the client', async () => {
  const { createNwcWalletFactory } = require('./nwcWallet');
  // As @getalby/sdk 9 builds them: the class name is all that says "network".
  class Nip47NetworkError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
    }
  }
  let created = 0;
  let closed = 0;
  const factory = createNwcWalletFactory({
    env: ENV,
    clientFactory: () => {
      created += 1;
      const first = created === 1;
      return {
        getBalance: () =>
          first ? Promise.reject(new Nip47NetworkError('Failed to connect', 'OTHER')) : Promise.resolve({ balance: 3000 }),
        close: () => {
          closed += 1;
        },
      };
    },
  });
  const handle = factory.open(nwcUrlFor(1));
  await assert.rejects(handle.getBalanceSats());
  assert.equal(closed, 1);
  assert.equal(await handle.getBalanceSats(), 3);
  assert.equal(created, 2);
});
