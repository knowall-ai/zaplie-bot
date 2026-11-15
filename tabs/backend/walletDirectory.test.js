const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createKeyCipher } = require('./keyCipher');
const { createPeopleStore } = require('./peopleStore');
const { createWalletDirectory } = require('./walletDirectory');
const { LnurlPayError } = require('./lnurlPay');
const { ALL_METHODS, createFakeNwc, nwcUrlFor } = require('./testSupport/fakeNwc');

const OID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ENV = { LNBITS_URL: 'https://bank.example' };

const tempStore = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-directory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createPeopleStore({
    filePath: path.join(dir, 'people.json'),
    cipher: createKeyCipher({ keyProvider: () => Buffer.alloc(32, 7) }),
  });
};

// Resolves any address on the allowed host; the real allow-list still runs.
const resolveOk = async (address) => {
  const { parseLightningAddress } = require('./lnurlPay');
  return { address: parseLightningAddress(address, ENV).address };
};

const harness = (t, { env = ENV, request } = {}) => {
  const fake = createFakeNwc({ env });
  const store = tempStore(t);
  const lnbitsCalls = [];
  const directory = createWalletDirectory({
    store,
    env,
    nwc: fake.factory,
    resolvePayRequest: resolveOk,
    request:
      request ||
      (async (route) => {
        lnbitsCalls.push(route);
        throw new Error(`unexpected LNbits call ${route}`);
      }),
  });
  return { directory, fake, store, lnbitsCalls };
};

test('an operator links a wallet by its NWC connection after it answers', async (t) => {
  const { directory, fake, store } = harness(t);
  fake.add(nwcUrlFor(1), { balanceSats: 2100 });

  const { person, balanceSats } = await directory.linkAllowanceWallet({
    oid: OID,
    displayName: 'Ada',
    nwcUrl: nwcUrlFor(1),
    lightningAddress: 'zaplie-0f8fad5bd9cb@bank.example',
  });

  assert.equal(balanceSats, 2100);
  assert.equal(person.allowance.source, 'operator');
  assert.match(person.allowance.walletId, /^nwc_/);
  assert.equal(person.allowance.lightningAddress, 'zaplie-0f8fad5bd9cb@bank.example');
  assert.equal(store.get(OID).allowance.nwc, nwcUrlFor(1));
  assert.deepEqual(
    fake.calls.map((call) => call.method),
    ['get_info', 'get_balance'],
  );
});

test('a connection that does not answer, or lacks permissions, is not saved', async (t) => {
  const { directory, fake, store } = harness(t);
  await assert.rejects(
    directory.linkAllowanceWallet({ oid: OID, nwcUrl: nwcUrlFor(9), lightningAddress: 'zaplie-x@bank.example' }),
    (error) => error.status === 502 && error.expose,
  );
  fake.add(nwcUrlFor(2), { methods: ['get_info', 'get_balance'] });
  await assert.rejects(
    directory.linkAllowanceWallet({ oid: OID, nwcUrl: nwcUrlFor(2), lightningAddress: 'zaplie-x@bank.example' }),
    (error) => error.status === 400 && /lacks permissions/.test(error.message),
  );
  await assert.rejects(
    directory.linkAllowanceWallet({ oid: OID, nwcUrl: 'not a connection', lightningAddress: 'zaplie-x@bank.example' }),
    (error) => error.status === 400,
  );
  assert.equal(store.get(OID), null);
});

test('a connection or address already linked to someone else is refused', async (t) => {
  const { directory, fake } = harness(t);
  fake.add(nwcUrlFor(1));
  fake.add(nwcUrlFor(2));
  await directory.linkAllowanceWallet({ oid: OID, nwcUrl: nwcUrlFor(1), lightningAddress: 'zaplie-a@bank.example' });

  await assert.rejects(
    directory.linkAllowanceWallet({ oid: OTHER, nwcUrl: nwcUrlFor(1), lightningAddress: 'zaplie-b@bank.example' }),
    (error) => error.status === 409 && /NWC connection/.test(error.message),
  );
  await assert.rejects(
    directory.linkAllowanceWallet({ oid: OTHER, nwcUrl: nwcUrlFor(2), lightningAddress: 'zaplie-a@bank.example' }),
    (error) => error.status === 409 && /Lightning address/.test(error.message),
  );
});

test('the Allowance address comes from the connection when not typed, and must be on an allowed host', async (t) => {
  const { directory, fake } = harness(t);
  const withLud16 = `${nwcUrlFor(3)}&lud16=${encodeURIComponent('zaplie-c@bank.example')}`;
  fake.add(withLud16);
  const { person } = await directory.linkAllowanceWallet({ oid: OID, nwcUrl: withLud16 });
  assert.equal(person.allowance.lightningAddress, 'zaplie-c@bank.example');

  fake.add(nwcUrlFor(4));
  await assert.rejects(
    directory.linkAllowanceWallet({ oid: OTHER, nwcUrl: nwcUrlFor(4), lightningAddress: 'someone@wallet.other' }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    directory.linkAllowanceWallet({ oid: OTHER, nwcUrl: nwcUrlFor(4) }),
    (error) => error.status === 400 && /Lightning address/.test(error.message),
  );
});

test('a new person waits for an admin; signing in creates nothing in any wallet backend', async (t) => {
  const { directory, fake } = harness(t, { env: { ...ENV, LNBITS_API_TOKEN: 'token', ZAPLIE_AUTO_PROVISION: 'true' } });
  const result = await directory.ensurePerson({ oid: OID, displayName: 'Ada' });
  assert.equal(result.awaitingOperator, true);
  assert.equal(result.person.allowance, null);
  assert.deepEqual(result.createdWallets, []);
  assert.deepEqual(fake.calls, []);
});

test('provisionPeople links what a provisioner made, skips the linked and reports failures', async (t) => {
  const { directory, fake, store } = harness(t);
  fake.add(nwcUrlFor(1));
  await directory.linkAllowanceWallet({ oid: OTHER, nwcUrl: nwcUrlFor(1), lightningAddress: 'zaplie-other@bank.example' });
  const asked = [];
  const provisioner = {
    id: 'fake',
    provisionAllowance: async (person, options) => {
      asked.push({ person, options });
      if (person.displayName === 'Broken') {
        throw Object.assign(new Error('Creating the pay link: LNbits answered 500'), { expose: true });
      }
      fake.add(nwcUrlFor(5));
      return { nwcUrl: nwcUrlFor(5), lightningAddress: 'zaplie-0f8fad5bd9cb@bank.example' };
    },
  };
  const THIRD = '11111111-2222-4333-8444-555555555555';
  const results = await directory.provisionPeople({
    provisioner,
    people: [
      { oid: OID.toUpperCase(), displayName: 'Ada' },
      { oid: OTHER },
      { oid: THIRD, displayName: 'Broken' },
      { oid: 'not-an-oid' },
    ],
    budgetSats: 25000,
    refreshSeconds: 604800,
  });

  assert.deepEqual(results.map((result) => result.status), ['provisioned', 'already-linked', 'failed', 'failed']);
  assert.equal(results[0].lightningAddress, 'zaplie-0f8fad5bd9cb@bank.example');
  assert.match(results[2].message, /pay link/);
  assert.deepEqual(asked[0].options, { budgetSats: 25000, refreshSeconds: 604800 });
  assert.equal(asked.length, 2);
  assert.equal(store.get(OID).allowance.source, 'operator');
  assert.equal(store.get(THIRD), null);
  assert.equal(JSON.stringify(results).includes('nostr+walletconnect'), false);
});

test('a receive address is resolved before it is saved; allowance and external addresses are refused', async (t) => {
  const { directory, fake, store } = harness(t);
  store.upsertProfile({ oid: OID });
  fake.add(nwcUrlFor(1));
  await directory.linkAllowanceWallet({ oid: OTHER, nwcUrl: nwcUrlFor(1), lightningAddress: 'team-a@bank.example' });

  await assert.rejects(
    directory.setReceiveTarget(OID, { lightningAddress: 'zaplie-0f8fad5bd9cb@bank.example' }),
    /allowance address/,
  );
  await assert.rejects(directory.setReceiveTarget(OID, { lightningAddress: 'team-a@bank.example' }), /allowance address/);
  // Not on the allowed host: Ben's policy keeps allowance sats inside the instance.
  await assert.rejects(
    directory.setReceiveTarget(OID, { lightningAddress: 'ada@wallet.other' }),
    (error) => error.status === 400,
  );

  const person = await directory.setReceiveTarget(OID, { lightningAddress: 'Ada@bank.example' });
  assert.equal(person.receive.lightningAddress, 'ada@bank.example');
  const cleared = await directory.setReceiveTarget(OID, { lightningAddress: null });
  assert.equal(cleared.receive, null);
});

test('a recipient is invoiced only at their registered address', async (t) => {
  const store = tempStore(t);
  store.upsertProfile({ oid: OID, displayName: 'Ada' });
  const invoices = [];
  const directory = createWalletDirectory({
    store,
    env: ENV,
    nwc: createFakeNwc().factory,
    requestAddressInvoice: async (address, amount, memo) => {
      invoices.push({ address, amount, memo });
      if (address === 'gone@bank.example') throw new LnurlPayError('The Lightning address answered with status 404.', 404);
      return 'lnbc200n1paddress';
    },
  });

  await assert.rejects(
    directory.createInvoiceFor(OID, { amountSats: 20, memo: 'thanks' }),
    (error) => error.status === 409 && /Ada has not set up/.test(error.message),
  );
  store.setReceiveTarget(OID, { lightningAddress: 'ada@bank.example' });
  assert.deepEqual(await directory.createInvoiceFor(OID, { amountSats: 20, memo: 'thanks' }), {
    paymentRequest: 'lnbc200n1paddress',
    via: 'lightning-address',
  });
  assert.deepEqual(invoices, [{ address: 'ada@bank.example', amount: 20, memo: 'thanks' }]);

  store.setReceiveTarget(OID, { lightningAddress: 'gone@bank.example' });
  await assert.rejects(directory.createInvoiceFor(OID, { amountSats: 20, memo: 'x' }), (error) => error.expose);
  await assert.rejects(directory.createInvoiceFor(OTHER, { amountSats: 20, memo: 'x' }), (error) => error.status === 404);
});

test('balances come from the Allowance wallet over NWC; budget only when reported', async (t) => {
  const { directory, fake } = harness(t);
  fake.add(nwcUrlFor(1), { balanceSats: 300 });
  await directory.linkAllowanceWallet({ oid: OID, nwcUrl: nwcUrlFor(1), lightningAddress: 'zaplie-a@bank.example' });
  assert.deepEqual(await directory.balancesFor(OID), { allowanceSats: 300, budget: null });

  fake.add(nwcUrlFor(2), {
    balanceSats: 50,
    methods: [...ALL_METHODS, 'get_budget'],
    budget: { used_budget: 20000, total_budget: 100000, renewal_period: 'weekly' },
  });
  await directory.linkAllowanceWallet({ oid: OTHER, nwcUrl: nwcUrlFor(2), lightningAddress: 'zaplie-b@bank.example' });
  const { budget } = await directory.balancesFor(OTHER);
  assert.deepEqual(budget, { totalSats: 100, usedSats: 20, renewsAt: null, renewalPeriod: 'weekly' });
});

test('the Treasury needs its NWC connection configured', (t) => {
  const { directory } = harness(t);
  assert.throws(() => directory.treasuryWallet(), (error) => error.status === 503 && /ZAPLIE_TREASURY_NWC/.test(error.message));
});
