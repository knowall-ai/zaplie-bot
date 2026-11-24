const assert = require('node:assert/strict');
const test = require('node:test');
const { allowanceWalletName, createLnbitsProvisioner, newNwcKeyPair, withSecret } = require('./lnbitsProvisioner');
const { parseNwcUrl } = require('./nwcWallet');

const ENV = { LNBITS_URL: 'https://bank.example' };
const TOKEN = 'lnbits-acl-token-short-lived-0123456789';
const OID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PROVIDER = 'f'.repeat(64);
const ADMINKEY = 'a'.repeat(32);

// A fake LNbits: records every call with the credential it carried.
const fakeLnbits = ({ existing = [], fail = {} } = {}) => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', bearer: options.bearer, walletKey: options.walletKey, body: options.body });
    const key = Object.keys(fail).find((prefix) => path.startsWith(prefix));
    if (key) throw Object.assign(new Error(`LNbits request failed with status ${fail[key]}`), { upstreamStatus: fail[key] });
    if (path === '/api/v1/wallets') return existing;
    if (path === '/api/v1/wallet') return { id: 'w-new', name: options.body.name, adminkey: ADMINKEY, inkey: 'b'.repeat(32) };
    if (path === '/lnurlp/api/v1/links') return { id: 'link-1', username: options.body.username };
    if (path.startsWith('/nwcprovider/api/v1/nwc/')) return { data: {} };
    if (path.startsWith('/nwcprovider/api/v1/pairing/')) {
      return `nostr+walletconnect://${PROVIDER}?relay=wss://bank.example/nostrclient/api/v1/relay&secret=${path.split('/').pop()}`;
    }
    throw new Error(`unexpected ${path}`);
  };
  return { request, calls };
};

const provision = (lnbits) =>
  createLnbitsProvisioner({ token: TOKEN, request: lnbits.request, env: ENV }).provisionAllowance(
    { oid: OID, displayName: 'Ada Lovelace' },
    { budgetSats: 25000, refreshSeconds: 604800 },
  );

test('creates wallet, pay link and NWC connection; returns only the connection and the address', async () => {
  const lnbits = fakeLnbits();
  const result = await provision(lnbits);

  assert.deepEqual(Object.keys(result).sort(), ['lightningAddress', 'nwcUrl']);
  assert.equal(result.lightningAddress, 'zaplie-0f8fad5bd9cb@bank.example');
  const parsed = parseNwcUrl(result.nwcUrl, ENV);
  assert.equal(parsed.walletPubkey, PROVIDER);
  assert.equal(JSON.stringify(result).includes(ADMINKEY), false);

  const [list, create, link, register, pairing] = lnbits.calls;
  assert.deepEqual([list.path, list.bearer], ['/api/v1/wallets', TOKEN]);
  assert.deepEqual([create.method, create.bearer, create.body.name], ['POST', TOKEN, allowanceWalletName({ oid: OID, displayName: 'Ada Lovelace' })]);
  // The token stops at wallet creation; the new wallet's own key does the rest.
  for (const call of [link, register, pairing]) {
    assert.equal(call.bearer, undefined);
    assert.equal(call.walletKey, ADMINKEY);
  }
  assert.equal(link.body.username, 'zaplie-0f8fad5bd9cb');
  assert.equal(link.body.max, 25000);
  assert.deepEqual(register.body.permissions, ['pay', 'invoice', 'lookup', 'history', 'balance', 'info']);
  assert.equal(register.body.budgets[0].budget_msats, 25_000_000);
  assert.equal(register.body.budgets[0].refresh_window, 604800);

  // The real secret never travels to LNbits: the pairing call used a throwaway.
  const secret = new URL(result.nwcUrl.replace('nostr+walletconnect://', 'http://')).searchParams.get('secret');
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(pairing.path.endsWith(secret), false);
  assert.equal(register.path.split('/').pop(), newNwcKeyPairPubOf(secret));
});

// The registered public key must be the one derived from the secret.
function newNwcKeyPairPubOf(secretHex) {
  const crypto = require('crypto');
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(secretHex, 'hex'));
  return ecdh.getPublicKey('hex', 'compressed').slice(2);
}

test('a wallet left by an earlier run is refused, never duplicated', async () => {
  const name = allowanceWalletName({ oid: OID, displayName: 'Ada Lovelace' });
  const lnbits = fakeLnbits({ existing: [{ id: 'w-old', name }] });
  await assert.rejects(provision(lnbits), (error) => error.status === 409 && error.expose && /already has a wallet/.test(error.message));
  assert.equal(lnbits.calls.filter((call) => call.method === 'POST').length, 0);
});

test('LNbits refusals name the step, never the token', async () => {
  for (const [prefix, status, text] of [
    ['/api/v1/wallets', 401, /refused the token/],
    ['/lnurlp', 404, /extension enabled/],
    ['/nwcprovider/api/v1/nwc/', 500, /answered 500/],
  ]) {
    const lnbits = fakeLnbits({ fail: { [prefix]: status } });
    await assert.rejects(provision(lnbits), (error) => error.expose && text.test(error.message) && !error.message.includes(TOKEN));
  }
});

test('a missing or malformed token is refused before any call', () => {
  for (const token of [undefined, '', 'short', 'has a space in it 0123456789']) {
    assert.throws(() => createLnbitsProvisioner({ token, env: ENV }), (error) => error.status === 400);
  }
});

test('key pairs and wallet names', () => {
  const { secret, pubkey } = newNwcKeyPair();
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(pubkey, newNwcKeyPairPubOf(secret));
  assert.ok(allowanceWalletName({ oid: OID, displayName: 'x'.repeat(200) }).length <= 64);
  assert.ok(allowanceWalletName({ oid: OID, displayName: 'x'.repeat(200) }).endsWith('(zaplie-0f8fad5bd9cb)'));
  assert.throws(() => withSecret('https://not-nwc', secret), /pairing URL/);
});
