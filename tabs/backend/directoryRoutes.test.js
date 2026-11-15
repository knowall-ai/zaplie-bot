process.env.TAB_BACKEND_TOKEN = 'internal-test-token';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after, before, test } = require('node:test');
const express = require('express');
const { createDirectoryRouter } = require('./directoryRoutes');
const { createKeyCipher } = require('./keyCipher');
const { createPeopleStore } = require('./peopleStore');
const { createWalletDirectory } = require('./walletDirectory');

const ME = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PEER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ADMIN_KEY = 'a'.repeat(32);
const INVOICE_KEY = 'b'.repeat(32);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-directory-routes-'));
const store = createPeopleStore({
  filePath: path.join(dir, 'people.json'),
  cipher: createKeyCipher({ keyProvider: () => Buffer.alloc(32, 9) }),
});
const invoices = [];
const directory = createWalletDirectory({
  store,
  env: {},
  request: async (route, options = {}) => {
    if (route === '/api/v1/wallet') return { name: 'Allowance', balance: 12000 };
    if (route === '/api/v1/payments' && options.method === 'POST') {
      invoices.push(options);
      return { payment_request: 'lnbc120n1pinvoice', checking_id: 'inv-1' };
    }
    throw new Error(`unexpected ${route}`);
  },
});

// Bearer <oid> stands in for a verified MSAL token; "admin" for Zaplie.Admin.
const requireMsalOid = async (req, res) => {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!match) {
    res.status(401).json({ error: 'missing bearer token' });
    return null;
  }
  return match[1];
};
const adminAuth = (req, res, next) =>
  req.headers.authorization === 'Bearer admin' ? next() : res.status(403).json({ error: 'admin only' });

let server;
let base;
before(async () => {
  store.upsertProfile({ oid: ME, displayName: 'Me' });
  store.setAllowanceWallet(ME, { walletId: 'w-me', adminkey: ADMIN_KEY, inkey: INVOICE_KEY, source: 'operator' });
  store.upsertProfile({ oid: PEER, displayName: 'Peer' });
  store.setReceiveTarget(PEER, { inkey: 'c'.repeat(32) });
  const app = express();
  app.use(express.json());
  app.use('/api/directory', createDirectoryRouter({ directory: () => directory, requireMsalOid, adminAuth }));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}/api/directory`;
      resolve();
    });
  });
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method, route, authorization, body) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
};

test('the signed-in person sees their own entry and balances, never a key', async () => {
  const response = await call('GET', '/me', `Bearer ${ME}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.oid, ME);
  assert.equal(response.body.allowanceWalletId, 'w-me');
  assert.equal(response.body.allowanceSats, 12);
  assert.equal(response.body.provisioning, 'operator');
  assert.equal(response.text.includes(ADMIN_KEY), false);
  assert.equal(response.text.includes(INVOICE_KEY), false);
});

test('someone outside the directory gets 403 from /me', async () => {
  const response = await call('GET', '/me', 'Bearer 11111111-2222-4333-8444-555555555555');
  assert.equal(response.status, 403);
});

test('the receive body accepts only the two documented fields', async () => {
  assert.equal((await call('PUT', '/me/receive', `Bearer ${ME}`, { aadObjectId: PEER })).status, 400);
  assert.equal((await call('PUT', '/me/receive', `Bearer ${ME}`, {})).status, 400);
  assert.equal((await call('PUT', '/me/receive', undefined, { invoiceKey: null })).status, 401);
  const cleared = await call('PUT', '/me/receive', `Bearer ${ME}`, { invoiceKey: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.receive.invoiceKeyRegistered, false);
});

test('admin routes need the admin role and never return keys', async () => {
  assert.equal((await call('GET', '/admin/people', `Bearer ${ME}`)).status, 403);
  const listed = await call('GET', '/admin/people', 'Bearer admin');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.people.map((person) => person.oid).sort(), [ME, PEER].sort());
  assert.equal(listed.text.includes(ADMIN_KEY), false);
  const provision = await call('POST', `/admin/people/${PEER}/provision`, 'Bearer admin');
  assert.equal(provision.status, 409);
});

test('internal routes take only the shared token', async () => {
  assert.equal((await call('GET', '/internal/people', `Bearer ${ME}`)).status, 401);
  const listed = await call('GET', '/internal/people', 'internal-test-token');
  assert.equal(listed.status, 200);
  const me = listed.body.people.find((person) => person.oid === ME);
  assert.deepEqual(me.allowanceWallet, { id: 'w-me', inkey: INVOICE_KEY });
  assert.equal(listed.text.includes(ADMIN_KEY), false);
});

test('ensure hands the bot the caller\'s own Allowance keys', async () => {
  const response = await call('POST', '/internal/people/ensure', 'internal-test-token', {
    aadObjectId: ME.toUpperCase(),
    displayName: 'Me',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.person.allowanceWallet, { id: 'w-me', adminkey: ADMIN_KEY, inkey: INVOICE_KEY });
  assert.equal(response.body.awaitingOperator, false);
  assert.equal(
    (await call('POST', '/internal/people/ensure', 'internal-test-token', { aadObjectId: 'lnbits-user-1' })).status,
    400,
  );
});

test('the bot invoices a recipient without ever seeing their key', async () => {
  const response = await call('POST', `/internal/people/${PEER}/invoices`, 'internal-test-token', {
    amountSats: 12,
    memo: 'thanks',
    extra: { tag: 'zap', to: { user: PEER, displayName: 'Peer' } },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.paymentRequest, 'lnbc120n1pinvoice');
  assert.equal(response.text.includes('c'.repeat(32)), false);
  assert.equal(invoices.at(-1).walletKey, 'c'.repeat(32));

  const keyInExtra = await call('POST', `/internal/people/${PEER}/invoices`, 'internal-test-token', {
    amountSats: 12,
    memo: 'thanks',
    extra: { from: { adminkey: ADMIN_KEY } },
  });
  assert.equal(keyInExtra.status, 400);
  const fractional = await call('POST', `/internal/people/${PEER}/invoices`, 'internal-test-token', {
    amountSats: 1.5,
    memo: 'thanks',
  });
  assert.equal(fractional.status, 400);
});

test('an unregistered recipient is a 409 the bot can relay', async () => {
  const response = await call('POST', `/internal/people/${ME}/invoices`, 'internal-test-token', {
    amountSats: 12,
    memo: 'thanks',
  });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /has not set up where they receive/);
});
