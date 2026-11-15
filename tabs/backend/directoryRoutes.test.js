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
const { createZapRecordStore } = require('./zapRecordStore');
const { createFakeNwc, nwcUrlFor } = require('./testSupport/fakeNwc');

const ME = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PEER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ENV = { LNBITS_URL: 'https://bank.example' };
const SECRET = new URL(nwcUrlFor(1).replace('nostr+walletconnect://', 'http://')).searchParams.get('secret');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-directory-routes-'));
const store = createPeopleStore({
  filePath: path.join(dir, 'people.json'),
  cipher: createKeyCipher({ keyProvider: () => Buffer.alloc(32, 9) }),
});
const records = createZapRecordStore({ filePath: path.join(dir, 'zap-records.json') });
const fake = createFakeNwc({ env: ENV });
const directory = createWalletDirectory({
  store,
  env: ENV,
  nwc: fake.factory,
  resolvePayRequest: async (address) => ({ address: address.toLowerCase() }),
});
const zaps = [];
const rewards = [];
let nextZapError = null;
const provisionerCalls = [];
const TOKEN = 'lnbits-acl-token-short-lived-0123456789';

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
  fake.add(nwcUrlFor(1), { balanceSats: 12 });
  store.upsertProfile({ oid: ME, displayName: 'Me' });
  store.setAllowanceWallet(ME, { walletId: 'nwc_me', nwc: nwcUrlFor(1), lightningAddress: 'zaplie-me@bank.example', source: 'operator' });
  store.upsertProfile({ oid: PEER, displayName: 'Peer' });
  store.setReceiveTarget(PEER, { lightningAddress: 'peer@bank.example' });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/directory',
    createDirectoryRouter({
      directory: () => directory,
      requireMsalOid,
      adminAuth,
      zapRecords: () => records,
      sendZap: async (input) => {
        zaps.push(input);
        if (nextZapError) {
          const error = nextZapError;
          nextZapError = null;
          throw error;
        }
        return { payment_hash: 'ab'.repeat(32) };
      },
      payReward: async (input) => {
        rewards.push(input);
        return { payment_hash: 'cd'.repeat(32) };
      },
      // A fake provisioner over the fake NWC wallets: what a real one returns.
      createProvisioner: (kind, { token }) => {
        provisionerCalls.push({ kind, tokenSeen: token === TOKEN });
        if (kind !== 'lnbits') throw Object.assign(new Error('unknown provisioner'), { status: 400, expose: true });
        return {
          id: kind,
          provisionAllowance: async (person) => {
            const seed = `prov-${person.oid}`;
            fake.add(nwcUrlFor(seed));
            return { nwcUrl: nwcUrlFor(seed), lightningAddress: `zaplie-${person.oid.slice(0, 8)}@bank.example` };
          },
        };
      },
    }),
  );
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

const noSecret = (text) => {
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes('nostr+walletconnect'), false);
};

test('the signed-in person sees their own entry and balance, never the connection', async () => {
  const response = await call('GET', '/me', `Bearer ${ME}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.oid, ME);
  assert.equal(response.body.allowanceWalletId, 'nwc_me');
  assert.equal(response.body.allowanceSats, 12);
  assert.equal(response.body.budget, null);
  noSecret(response.text);
});

test('/me lists the accepted Lightning address domains, without the wildcard', async () => {
  const previous = process.env.ZAPLIE_LIGHTNING_ADDRESS_DOMAINS;
  process.env.ZAPLIE_LIGHTNING_ADDRESS_DOMAINS = 'bank.example, *, pay.example';
  try {
    const response = await call('GET', '/me', `Bearer ${ME}`);
    assert.deepEqual(response.body.receiveDomains, ['bank.example', 'pay.example']);
  } finally {
    if (previous === undefined) delete process.env.ZAPLIE_LIGHTNING_ADDRESS_DOMAINS;
    else process.env.ZAPLIE_LIGHTNING_ADDRESS_DOMAINS = previous;
  }
});

test('someone outside the directory gets 403 from /me', async () => {
  const response = await call('GET', '/me', 'Bearer 11111111-2222-4333-8444-555555555555');
  assert.equal(response.status, 403);
});

test('the receive body accepts only a Lightning address', async () => {
  assert.equal((await call('PUT', '/me/receive', `Bearer ${ME}`, { invoiceKey: 'a'.repeat(32) })).status, 400);
  assert.equal((await call('PUT', '/me/receive', `Bearer ${ME}`, {})).status, 400);
  assert.equal((await call('PUT', '/me/receive', undefined, { lightningAddress: null })).status, 401);
  const saved = await call('PUT', '/me/receive', `Bearer ${ME}`, { lightningAddress: 'Me@bank.example' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.receive.lightningAddress, 'me@bank.example');
});

test('admins link an Allowance wallet by NWC connection; it is never returned', async () => {
  assert.equal((await call('GET', '/admin/people', `Bearer ${ME}`)).status, 403);
  fake.add(nwcUrlFor(2), { balanceSats: 40 });
  const linked = await call('PUT', `/admin/people/${PEER}/allowance-wallet`, 'Bearer admin', {
    nwcUrl: nwcUrlFor(2),
    lightningAddress: 'zaplie-peer@bank.example',
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.balanceSats, 40);
  assert.equal(linked.body.person.allowanceLightningAddress, 'zaplie-peer@bank.example');
  noSecret(linked.text);

  const listed = await call('GET', '/admin/people', 'Bearer admin');
  assert.deepEqual(listed.body.people.map((person) => person.oid).sort(), [ME, PEER].sort());
  noSecret(listed.text);

  assert.equal(
    (await call('PUT', `/admin/people/${PEER}/allowance-wallet`, 'Bearer admin', { adminkey: 'a'.repeat(32), inkey: 'b'.repeat(32) })).status,
    400,
  );
  assert.deepEqual(listed.body.provisioners, ['lnbits']);
});

test('internal routes take only the shared token and return no credential', async () => {
  assert.equal((await call('GET', '/internal/people', `Bearer ${ME}`)).status, 401);
  const listed = await call('GET', '/internal/people', 'internal-test-token');
  assert.equal(listed.status, 200);
  noSecret(listed.text);
  const ensured = await call('POST', '/internal/people/ensure', 'internal-test-token', { aadObjectId: ME.toUpperCase(), displayName: 'Me' });
  assert.equal(ensured.status, 200);
  assert.equal(ensured.body.person.allowanceWalletId, 'nwc_me');
  assert.equal(ensured.body.awaitingOperator, false);
  noSecret(ensured.text);
  assert.equal(
    (await call('POST', '/internal/people/ensure', 'internal-test-token', { aadObjectId: 'lnbits-user-1' })).status,
    400,
  );
});

test('the bot pays a zap between members by Entra id, and learns the outcome', async () => {
  const body = { senderOid: ME, recipientOid: PEER, amountSats: 12, memo: 'thanks', idempotencyKey: 'zap-card-key-000001' };
  const paid = await call('POST', '/internal/zaps', 'internal-test-token', body);
  assert.equal(paid.status, 200);
  assert.deepEqual(paid.body, { paymentHash: 'ab'.repeat(32), outcome: 'paid' });
  assert.deepEqual(zaps.at(-1), {
    aadObjectId: ME,
    recipientUserId: PEER,
    amount: 12,
    memo: 'thanks',
    idempotencyKey: 'zap-card-key-000001',
    source: 'bot',
  });

  nextZapError = Object.assign(new Error('Insufficient allowance balance'), { status: 409, expose: true, paymentOutcome: 'not_paid' });
  const refused = await call('POST', '/internal/zaps', 'internal-test-token', body);
  assert.deepEqual([refused.status, refused.body.outcome], [409, 'not_paid']);

  nextZapError = Object.assign(new Error('relay gone'), { status: 503 });
  const unknown = await call('POST', '/internal/zaps', 'internal-test-token', body);
  assert.deepEqual([unknown.status, unknown.body.outcome], [503, 'unknown']);
});

test('a client-supplied invoice or address is never accepted for payment', async () => {
  const before = zaps.length;
  for (const extra of [{ paymentRequest: 'lnbc10n1pexternal' }, { lightningAddress: 'evil@wallet.other' }]) {
    const response = await call('POST', '/internal/zaps', 'internal-test-token', {
      senderOid: ME,
      recipientOid: PEER,
      amountSats: 1,
      memo: 'x',
      idempotencyKey: 'zap-card-key-000002',
      ...extra,
    });
    assert.deepEqual([response.status, response.body.outcome], [400, 'not_paid']);
  }
  const reward = await call('POST', '/internal/rewards', 'internal-test-token', {
    recipientOid: PEER,
    amountSats: 1,
    memo: 'x',
    idempotencyKey: 'reward-key-00000001',
    paymentRequest: 'lnbc10n1pexternal',
  });
  assert.equal(reward.status, 400);
  assert.equal(zaps.length, before);
});

test('the bot pays a reward and reads the zap records', async () => {
  const paid = await call('POST', '/internal/rewards', 'internal-test-token', {
    recipientOid: PEER,
    recipientLabel: 'octocat',
    amountSats: 50,
    memo: 'GitHub: PR #7 merged',
    reward: { eventType: 'githubPrMerged', repo: 'acme/api', baseSats: 50 },
    idempotencyKey: 'reward-key-00000002',
  });
  assert.deepEqual(paid.body, { paymentHash: 'cd'.repeat(32), outcome: 'paid' });
  assert.equal(rewards.at(-1).reward.repo, 'acme/api');

  records.record({ paymentHash: 'ef'.repeat(32), amountSats: 3, memo: 'm', timeMs: 5000_000, from: { oid: ME }, to: { oid: PEER } });
  const listed = await call('GET', '/internal/zaps?since=4000', 'internal-test-token');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.zaps.map((zap) => zap.paymentHash), ['ef'.repeat(32)]);
});

test('admins provision people with a token used for that request only', async () => {
  const NEW = '22222222-3333-4444-8555-666666666666';
  const logged = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...args) => logged.push(args.map(String).join(' '));
  }
  try {
    const body = { provisioner: 'lnbits', token: TOKEN, people: [{ oid: NEW, displayName: 'New Person' }, { oid: ME }], budgetSats: 25000, period: 'weekly' };
    assert.equal((await call('POST', '/admin/people/provision', `Bearer ${ME}`, body)).status, 403);

    const response = await call('POST', '/admin/people/provision', 'Bearer admin', body);
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.results.map((result) => [result.oid, result.status]),
      [[NEW, 'provisioned'], [ME, 'already-linked']],
    );
    assert.equal(response.body.results[0].lightningAddress, 'zaplie-22222222@bank.example');
    assert.equal(provisionerCalls.at(-1).tokenSeen, true);

    assert.equal((await call('POST', '/admin/people/provision', 'Bearer admin', { ...body, period: 'hourly' })).status, 400);
    assert.equal((await call('POST', '/admin/people/provision', 'Bearer admin', { ...body, provisioner: 'other' })).status, 400);
    assert.equal((await call('POST', '/admin/people/provision', 'Bearer admin', { ...body, people: [] })).status, 400);

    // The token never comes back, never reaches a log line and is not on disk.
    assert.equal(response.text.includes(TOKEN), false);
    assert.equal(logged.some((line) => line.includes(TOKEN)), false);
    for (const file of fs.readdirSync(dir)) {
      assert.equal(fs.readFileSync(path.join(dir, file), 'utf8').includes(TOKEN), false, file);
    }
    noSecret(response.text);
  } finally {
    Object.assign(console, originals);
  }
});
