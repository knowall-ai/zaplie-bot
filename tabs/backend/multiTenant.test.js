// Tenant isolation end to end: real signed tokens (local keys per tenant),
// the real validator, tenant middleware, admin check, directory and setup
// routes, and the per-tenant data directory.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '99999999-9999-4999-8999-999999999999';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-tenants-'));
process.env.ZAPLIE_DATA_DIR = dataDir;
process.env.ZAPLIE_STORE_KEY = 'e'.repeat(64);
process.env.AAD_TENANT_ID = HOME;
process.env.AAD_CLIENT_ID = CLIENT_ID;
process.env.ZAPLIE_ALLOWED_TENANTS = `${HOME},${CUSTOMER}`;
process.env.TAB_BACKEND_TOKEN = 'internal-test-token';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = require('jose');
const { setKeyResolverForTests, verifyMsalPayload } = require('./msalValidator');
const { tenantMiddleware } = require('./tenantMiddleware');
const { createDirectoryRouter } = require('./directoryRoutes');
const tenantRoutes = require('./tenantRoutes');
const { runWithTenant } = require('./tenantContext');
const { peopleStore, resetPeopleStoreForTests } = require('./peopleStore');
const { resetTenantMarkerForTests } = require('./dataPaths');

const OID = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const keys = {};
let server;
let base;

const token = async (tid, { oid = OID(1), roles = [], wids = [], signer = tid, issuerTid = tid } = {}) =>
  new SignJWT({ tid, oid, roles, wids, acct: 0 })
    .setProtectedHeader({ alg: 'RS256', kid: `kid-${signer}` })
    .setIssuer(`https://login.microsoftonline.com/${issuerTid}/v2.0`)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(keys[signer].privateKey);

before(async () => {
  for (const tid of [HOME, CUSTOMER, STRANGER]) {
    keys[tid] = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(keys[tid].publicKey)), kid: `kid-${tid}`, alg: 'RS256' };
    keys[tid].jwks = createLocalJWKSet({ keys: [jwk] });
  }
  setKeyResolverForTests((tid) => keys[tid].jwks);
  resetPeopleStoreForTests();
  resetTenantMarkerForTests();

  runWithTenant(HOME, () => peopleStore().upsertProfile({ oid: OID(1), displayName: 'Home Person' }));
  runWithTenant(CUSTOMER, () => peopleStore().upsertProfile({ oid: OID(2), displayName: 'Customer Person' }));

  const app = express();
  app.use(express.json());
  app.use('/api', tenantMiddleware);
  app.use('/api/tenant', tenantRoutes);
  app.use('/api/directory', createDirectoryRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
});

after(() => {
  setKeyResolverForTests(null);
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method, route, bearer, { body, headers = {} } = {}) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const peopleNames = (response) => response.body.people.map((person) => person.displayName);

test('a token from a tenant not on the allow-list is refused even with a valid signature', async () => {
  const stranger = await token(STRANGER, { roles: ['Zaplie.Admin'] });
  await assert.rejects(verifyMsalPayload(stranger), /tenant Zaplie does not serve/);
  assert.equal((await call('GET', '/directory/admin/people', stranger)).status, 401);
});

test('a token is checked against its own tenant: another tenant cannot vouch for it', async () => {
  // Claims the home tenant but is signed with the customer's key.
  const forged = await token(HOME, { roles: ['Zaplie.Admin'], signer: CUSTOMER });
  await assert.rejects(verifyMsalPayload(forged));
  // Signed by the customer but issued as the home tenant.
  const wrongIssuer = await token(CUSTOMER, { issuerTid: HOME });
  await assert.rejects(verifyMsalPayload(wrongIssuer));
});

test('each organisation\'s admin sees only its own people', async () => {
  const home = await call('GET', '/directory/admin/people', await token(HOME, { roles: ['Zaplie.Admin'] }));
  const customer = await call('GET', '/directory/admin/people', await token(CUSTOMER, { oid: OID(2), roles: ['Zaplie.Admin'] }));
  assert.deepEqual(peopleNames(home), ['Home Person']);
  assert.deepEqual(peopleNames(customer), ['Customer Person']);
  // Each organisation's file lives in its own place; the root is the home tenant's.
  assert.ok(fs.existsSync(path.join(dataDir, 'tenants', CUSTOMER, 'people.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'tenant.json'), 'utf8')).tid, HOME);
});

test('a customer admin cannot reach the home organisation, whatever header they send', async () => {
  const customerAdmin = await token(CUSTOMER, { oid: OID(2), roles: ['Zaplie.Admin', 'Zaplie.PlatformOperator'] });
  const response = await call('GET', '/directory/admin/people', customerAdmin, {
    headers: { 'X-Zaplie-Act-As-Tenant': HOME },
  });
  assert.equal(response.status, 403);
  const platform = await call('GET', '/tenant/platform/tenants', customerAdmin);
  assert.equal(platform.status, 403);
});

test('a Global Administrator is a Zaplie admin of their own tenant without the app role', async () => {
  const globalAdmin = await token(CUSTOMER, { oid: OID(3), wids: ['62e90394-69f5-4237-9190-012177145e10'] });
  const response = await call('GET', '/directory/admin/people', globalAdmin);
  assert.equal(response.status, 200);
  assert.deepEqual(peopleNames(response), ['Customer Person']);
  const plain = await token(CUSTOMER, { oid: OID(4) });
  assert.equal((await call('GET', '/directory/admin/people', plain)).status, 403);
});

test('KnowAll\'s platform operator may read another organisation, and only read', async () => {
  const operator = await token(HOME, { oid: OID(9), roles: ['Zaplie.PlatformOperator'] });
  const read = await call('GET', '/directory/admin/people', operator, { headers: { 'X-Zaplie-Act-As-Tenant': CUSTOMER } });
  assert.equal(read.status, 200);
  assert.deepEqual(peopleNames(read), ['Customer Person']);
  const write = await call('PUT', `/directory/admin/people/${OID(2)}/allowance-wallet`, operator, {
    headers: { 'X-Zaplie-Act-As-Tenant': CUSTOMER },
    body: { nwcUrl: 'nostr+walletconnect://x' },
  });
  assert.equal(write.status, 403);
  const tenants = await call('GET', '/tenant/platform/tenants', operator);
  assert.deepEqual(tenants.body.tenants.map((entry) => [entry.tid, entry.people]).sort(), [[HOME, 1], [CUSTOMER, 1]].sort());
  // Not a stranger tenant, which is not allowed at all.
  const stranger = await call('GET', '/directory/admin/people', operator, { headers: { 'X-Zaplie-Act-As-Tenant': STRANGER } });
  assert.equal(stranger.status, 403);
});

test('the setup page is for that organisation\'s IT or Zaplie admins, and saves per tenant', async () => {
  const appAdmin = await token(CUSTOMER, { oid: OID(5), wids: ['9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3'] });
  const me = await call('GET', '/tenant/me', appAdmin);
  assert.deepEqual(me.body.roles, { zaplieAdmin: false, setupAdmin: true, platformOperator: false });
  assert.equal(me.body.tid, CUSTOMER);

  const saved = await call('PUT', '/tenant/setup', appAdmin, {
    body: { adminsGroupId: 'ABCDEF01-2345-4678-9abc-def012345678', guestAllowlist: ['@partner.example', 'Ann@Partner.example'] },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.settings.guestAllowlist, ['@partner.example', 'ann@partner.example']);

  const homeMe = await call('GET', '/tenant/me', await token(HOME, { roles: ['Zaplie.Admin'] }));
  assert.equal(homeMe.body.settings.adminsGroupId, null);

  const member = await token(CUSTOMER, { oid: OID(6) });
  assert.equal((await call('PUT', '/tenant/setup', member, { body: { adminsGroupId: null } })).status, 403);
  assert.equal((await call('PUT', '/tenant/setup', appAdmin, { body: { adminsGroupId: 'not-a-guid' } })).status, 400);
  assert.equal((await call('PUT', '/tenant/setup', appAdmin, { body: { somethingElse: 1 } })).status, 400);
});

test('the bot names its organisation, which must be allowed', async () => {
  const internal = { authorization: 'internal-test-token' };
  const customer = await call('GET', '/directory/internal/people', null, { headers: { ...internal, 'X-Zaplie-Tenant': CUSTOMER } });
  assert.deepEqual(peopleNames(customer), ['Customer Person']);
  const home = await call('GET', '/directory/internal/people', null, { headers: internal });
  assert.deepEqual(peopleNames(home), ['Home Person']);
  const stranger = await call('GET', '/directory/internal/people', null, { headers: { ...internal, 'X-Zaplie-Tenant': STRANGER } });
  assert.equal(stranger.status, 403);
});
