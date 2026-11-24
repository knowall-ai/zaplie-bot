const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createKeyCipher } = require('./keyCipher');
const { createPeopleStore, normalizeOid, toPublicPerson } = require('./peopleStore');

const OID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NWC = `nostr+walletconnect://${'b'.repeat(64)}?relay=wss://bank.example/nostrclient/api/v1/relay&secret=${'c'.repeat(64)}`;
const keyOf = (hex) => () => Buffer.from(hex.repeat(64).slice(0, 64), 'hex');

const tempStore = (t, keyHex = 'c') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-people-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'people.json');
  return {
    filePath,
    store: createPeopleStore({ filePath, cipher: createKeyCipher({ keyProvider: keyOf(keyHex) }) }),
  };
};

test('the NWC connection string is encrypted on disk and decrypted on read', (t) => {
  const { filePath, store } = tempStore(t);
  store.upsertProfile({ oid: OID.toUpperCase(), displayName: 'Ada' });
  store.setAllowanceWallet(OID, { walletId: 'nwc_1', nwc: NWC, lightningAddress: 'zaplie-0f8f@bank.example', source: 'operator' });
  store.setReceiveTarget(OID, { lightningAddress: 'ada@bank.example' });

  const raw = fs.readFileSync(filePath, 'utf8');
  assert.equal(raw.includes('c'.repeat(64)), false);
  assert.equal(raw.includes('nostr+walletconnect'), false);
  assert.match(raw, /enc:v1:/);

  const person = store.get(OID);
  assert.equal(person.oid, OID);
  assert.equal(person.allowance.nwc, NWC);
  assert.equal(store.findByAllowanceAddress('zaplie-0f8f@bank.example').oid, OID);
  assert.equal(person.receive.lightningAddress, 'ada@bank.example');
});

test('the store opened with another key refuses to hand out keys', (t) => {
  const { filePath, store } = tempStore(t);
  store.upsertProfile({ oid: OID });
  store.setAllowanceWallet(OID, { walletId: 'nwc_1', nwc: NWC, source: 'operator' });
  const wrong = createPeopleStore({ filePath, cipher: createKeyCipher({ keyProvider: keyOf('d') }) });
  assert.throws(() => wrong.get(OID), /could not be decrypted/);
});

test('a plaintext connection string written by hand is refused, not used', (t) => {
  const { filePath, store } = tempStore(t);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      people: { [OID]: { oid: OID, allowance: { walletId: 'nwc_1', nwc: NWC } } },
    }),
  );
  assert.throws(() => store.get(OID), /not encrypted/);
});

test('an unreadable store is an error, never an empty directory', (t) => {
  const { filePath, store } = tempStore(t);
  fs.writeFileSync(filePath, '{ not json');
  assert.throws(() => store.list(), /unreadable/);
});

test('an unchanged profile is not rewritten on every turn', (t) => {
  const { filePath, store } = tempStore(t);
  store.upsertProfile({ oid: OID, displayName: 'Ada', email: 'ada@example.test' });
  const before = fs.statSync(filePath).mtimeMs;
  fs.utimesSync(filePath, new Date(0), new Date(0));
  store.upsertProfile({ oid: OID, displayName: 'Ada', email: 'ada@example.test' });
  assert.equal(fs.statSync(filePath).mtimeMs, 0);
  store.upsertProfile({ oid: OID, displayName: 'Ada L.' });
  assert.notEqual(fs.statSync(filePath).mtimeMs, 0);
  assert.equal(store.get(OID).email, 'ada@example.test');
  assert.ok(before > 0);
});

test('only Entra object ids are accepted as people', (t) => {
  const { store } = tempStore(t);
  assert.equal(normalizeOid('../etc'), null);
  assert.equal(normalizeOid(OID.toUpperCase()), OID);
  assert.throws(() => store.upsertProfile({ oid: 'user-1' }), (error) => error.status === 400);
  assert.equal(store.get('user-1'), null);
});

test('the public projection carries no connection string', (t) => {
  const { store } = tempStore(t);
  store.upsertProfile({ oid: OID, displayName: 'Ada' });
  store.setAllowanceWallet(OID, { walletId: 'nwc_1', nwc: NWC, lightningAddress: 'zaplie-0f8f@bank.example', source: 'operator' });
  store.setReceiveTarget(OID, { lightningAddress: 'ada@bank.example' });
  const projected = toPublicPerson(store.get(OID));
  assert.deepEqual(projected, {
    oid: OID,
    displayName: 'Ada',
    email: '',
    allowanceWalletId: 'nwc_1',
    allowanceSource: 'operator',
    allowanceLightningAddress: 'zaplie-0f8f@bank.example',
    receive: { lightningAddress: 'ada@bank.example' },
  });
  assert.equal(JSON.stringify(projected).includes('c'.repeat(64)), false);
});
