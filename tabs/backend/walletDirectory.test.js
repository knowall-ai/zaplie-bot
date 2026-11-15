const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createKeyCipher } = require('./keyCipher');
const { createPeopleStore } = require('./peopleStore');
const { createWalletDirectory } = require('./walletDirectory');
const { LnurlPayError } = require('./lnurlPay');

const OID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const hex = (c) => c.repeat(32);

const tempStore = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-directory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createPeopleStore({
    filePath: path.join(dir, 'people.json'),
    cipher: createKeyCipher({ keyProvider: () => Buffer.alloc(32, 7) }),
  });
};

const httpError = (status) =>
  Object.assign(new Error(`LNbits request failed with status ${status}`), {
    status: status === 404 ? 404 : 502,
    upstreamStatus: status,
  });

// A fake LNbits keyed by wallet key; records every call so a test can say
// which credential reached which route.
const fakeLnbits = (wallets, { serviceWallets = [] } = {}) => {
  const calls = [];
  let created = 0;
  const request = async (route, options = {}) => {
    calls.push({ route, method: options.method || 'GET', walletKey: options.walletKey, apiToken: options.apiToken });
    if (route === '/api/v1/wallets') return serviceWallets;
    if (route === '/api/v1/wallet' && options.method === 'POST') {
      created += 1;
      const wallet = { id: `svc-${created}`, name: options.body.name, adminkey: hex(String(created)), inkey: hex(String(created + 4)) };
      serviceWallets.push(wallet);
      return wallet;
    }
    if (route === '/api/v1/wallet') {
      const wallet = wallets[options.walletKey];
      if (!wallet) throw httpError(401);
      return wallet;
    }
    if (route === '/api/v1/payments' && options.method === 'POST') {
      return { payment_request: 'lnbc200n1pinvoice', checking_id: 'inv-1' };
    }
    throw new Error(`unexpected ${route}`);
  };
  return { request, calls, serviceWallets };
};

test('with the API token a first sign-in gets an Allowance wallet under zaplie.service', async (t) => {
  const lnbits = fakeLnbits({});
  const directory = createWalletDirectory({
    store: tempStore(t),
    request: lnbits.request,
    env: { LNBITS_API_TOKEN: 'token' },
  });
  const [first, second] = await Promise.all([
    directory.ensurePerson({ oid: OID, displayName: 'Ada Lovelace' }),
    directory.ensurePerson({ oid: OID, displayName: 'Ada Lovelace' }),
  ]);
  assert.equal(first, second);
  assert.equal(first.created, true);
  assert.deepEqual(first.createdWallets, ['Allowance']);
  assert.equal(first.awaitingOperator, false);
  assert.equal(first.person.allowance.source, 'token');
  const creates = lnbits.calls.filter((call) => call.method === 'POST');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].apiToken, true);

  const again = await directory.ensurePerson({ oid: OID });
  assert.equal(again.created, false);
  assert.deepEqual(again.createdWallets, []);
  assert.equal(lnbits.calls.filter((call) => call.method === 'POST').length, 1);
});

test('without the token a new person waits for an operator and nothing is created', async (t) => {
  const lnbits = fakeLnbits({});
  const directory = createWalletDirectory({ store: tempStore(t), request: lnbits.request, env: {} });
  const result = await directory.ensurePerson({ oid: OID, displayName: 'Ada' });
  assert.equal(result.awaitingOperator, true);
  assert.equal(result.person.allowance, null);
  assert.deepEqual(lnbits.calls, []);
});

test('an operator links a wallet only when both keys open the same wallet', async (t) => {
  const wallets = {
    [hex('a')]: { id: 'w-1', name: 'Allowance - Ada', balance: 0 },
    [hex('b')]: { name: 'Allowance - Ada', balance: 0 },
    [hex('c')]: { name: 'Someone else', balance: 0 },
  };
  const store = tempStore(t);
  const directory = createWalletDirectory({ store, request: fakeLnbits(wallets).request, env: {} });

  await assert.rejects(
    directory.linkAllowanceWallet({ oid: OID, adminkey: hex('a'), inkey: hex('c') }),
    /different wallets/,
  );
  await assert.rejects(
    directory.linkAllowanceWallet({ oid: OID, adminkey: hex('b'), inkey: hex('a') }),
    /did not open a wallet/,
  );
  const { person, ownershipVerified } = await directory.linkAllowanceWallet({
    oid: OID,
    displayName: 'Ada',
    adminkey: hex('a'),
    inkey: hex('b'),
  });
  assert.equal(person.allowance.walletId, 'w-1');
  assert.equal(person.allowance.source, 'operator');
  assert.equal(ownershipVerified, false);

  await assert.rejects(
    directory.linkAllowanceWallet({ oid: OTHER, adminkey: hex('a'), inkey: hex('b') }),
    (error) => error.status === 409,
  );
});

test('with the token, a linked wallet must belong to zaplie.service', async (t) => {
  const wallets = {
    [hex('a')]: { id: 'w-1', name: 'Allowance', balance: 0 },
    [hex('b')]: { name: 'Allowance', balance: 0 },
  };
  const lnbits = fakeLnbits(wallets, { serviceWallets: [{ id: 'w-other' }] });
  const directory = createWalletDirectory({ store: tempStore(t), request: lnbits.request, env: { LNBITS_API_TOKEN: 'x' } });
  await assert.rejects(
    directory.linkAllowanceWallet({ oid: OID, adminkey: hex('a'), inkey: hex('b') }),
    /not owned by the Zaplie service account/,
  );
  lnbits.serviceWallets.push({ id: 'w-1' });
  const { ownershipVerified } = await directory.linkAllowanceWallet({ oid: OID, adminkey: hex('a'), inkey: hex('b') });
  assert.equal(ownershipVerified, true);
});

test('a receive invoice key must be a read key of a wallet that is not Zaplie\'s', async (t) => {
  const wallets = {
    [hex('d')]: { name: 'Private', balance: 21000 },
    [hex('e')]: { id: 'private-admin', name: 'Private', balance: 21000 },
    [hex('b')]: { name: 'Allowance', balance: 5000 },
  };
  const store = tempStore(t);
  store.upsertProfile({ oid: OID });
  store.setAllowanceWallet(OID, { walletId: 'w-1', adminkey: hex('a'), inkey: hex('b'), source: 'token' });
  const directory = createWalletDirectory({ store, request: fakeLnbits(wallets).request, env: {} });

  await assert.rejects(directory.setReceiveTarget(OID, { invoiceKey: hex('e') }), /admin key/);
  await assert.rejects(directory.setReceiveTarget(OID, { invoiceKey: hex('b') }), /Allowance wallet/);
  await assert.rejects(directory.setReceiveTarget(OID, { invoiceKey: hex('f') }), /did not open a wallet/);
  await assert.rejects(directory.setReceiveTarget(OID, { invoiceKey: 'short' }), (error) => error.status === 400);

  const person = await directory.setReceiveTarget(OID, { invoiceKey: hex('d') });
  assert.equal(person.receive.inkey, hex('d'));
  assert.deepEqual(await directory.balancesFor(OID), { allowanceSats: 5, privateSats: 21 });

  const cleared = await directory.setReceiveTarget(OID, { invoiceKey: null });
  assert.equal(cleared.receive, null);
});

test('a Lightning address is resolved before it is saved, and allowance links are refused', async (t) => {
  const store = tempStore(t);
  store.upsertProfile({ oid: OID });
  const resolved = [];
  const directory = createWalletDirectory({
    store,
    request: fakeLnbits({}).request,
    env: { LNBITS_URL: 'https://bank.example' },
    resolvePayRequest: async (address) => {
      resolved.push(address);
      if (address === 'nobody@bank.example') throw new LnurlPayError('The Lightning address answered with status 404.', 404);
      return { address: address.toLowerCase() };
    },
  });
  await assert.rejects(
    directory.setReceiveTarget(OID, { lightningAddress: 'zaplie-0f8fad5bd9cb@bank.example' }),
    /allowance address/,
  );
  await assert.rejects(
    directory.setReceiveTarget(OID, { lightningAddress: 'nobody@bank.example' }),
    (error) => error.status === 404,
  );
  const person = await directory.setReceiveTarget(OID, { lightningAddress: 'Ada@bank.example' });
  assert.equal(person.receive.lightningAddress, 'ada@bank.example');
  assert.equal(person.receive.inkey, null);
});

test('a recipient is invoiced at their address first, else by invoice key, else refused', async (t) => {
  const store = tempStore(t);
  store.upsertProfile({ oid: OID, displayName: 'Ada' });
  const lnbits = fakeLnbits({});
  const addressInvoices = [];
  const directory = createWalletDirectory({
    store,
    request: lnbits.request,
    env: {},
    requestAddressInvoice: async (address, amount, memo) => {
      addressInvoices.push({ address, amount, memo });
      return 'lnbc200n1paddress';
    },
  });

  await assert.rejects(
    directory.createInvoiceFor(OID, { amountSats: 20, memo: 'thanks' }),
    (error) => error.status === 409 && /Ada has not set up/.test(error.message),
  );

  store.setReceiveTarget(OID, { inkey: hex('d') });
  const byKey = await directory.createInvoiceFor(OID, { amountSats: 20, memo: 'thanks', extra: { tag: 'zap' } });
  assert.deepEqual(byKey, { paymentRequest: 'lnbc200n1pinvoice', invoiceId: 'inv-1', via: 'invoice-key' });
  assert.equal(lnbits.calls.at(-1).walletKey, hex('d'));

  store.setReceiveTarget(OID, { lightningAddress: 'ada@bank.example', inkey: hex('d') });
  const byAddress = await directory.createInvoiceFor(OID, { amountSats: 20, memo: 'thanks' });
  assert.equal(byAddress.via, 'lightning-address');
  assert.deepEqual(addressInvoices, [{ address: 'ada@bank.example', amount: 20, memo: 'thanks' }]);

  await assert.rejects(
    directory.createInvoiceFor(OTHER, { amountSats: 20, memo: 'x' }),
    (error) => error.status === 404,
  );
});
