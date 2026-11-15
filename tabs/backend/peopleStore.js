// filepath: tabs/backend/peopleStore.js
// Zaplie's own directory: Entra object id -> the person's Allowance wallet
// (owned by zaplie.service) and where they receive zaps (their Private wallet
// stays under their own LNbits account). It replaces reading LNbits'
// external_id through the admin Users API.
//
// On disk (people.json under ZAPLIE_DATA_DIR) every wallet key is sealed by
// keyCipher.js; callers only ever see decrypted keys through `get`/`list`, and
// `toPublicPerson` is the projection anything leaving the server goes through.
const fs = require('fs');
const { dataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');
const { createKeyCipher } = require('./keyCipher');

const STORE_VERSION = 1;
const OID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DISPLAY_NAME = 256;
const MAX_EMAIL = 320;

class PeopleStoreError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'PeopleStoreError';
    this.status = status;
  }
}

/** The canonical (lower-case) form of an Entra object id, or null. */
const normalizeOid = (value) => {
  const oid = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return OID_PATTERN.test(oid) ? oid : null;
};

const cleanText = (value, max) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

const SEALED_FIELDS = {
  allowance: ['adminkey', 'inkey'],
  receive: ['inkey'],
};

const createPeopleStore = ({
  filePath = dataPath('people.json'),
  cipher = createKeyCipher(),
  now = () => new Date().toISOString(),
} = {}) => {
  const readRaw = () => {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: STORE_VERSION, people: {} };
      // An unreadable directory must not read as "nobody is registered": that
      // would provision everyone a second Allowance wallet.
      throw new PeopleStoreError(`people store is unreadable: ${error.message}`);
    }
    if (!parsed || typeof parsed.people !== 'object' || Array.isArray(parsed.people)) {
      throw new PeopleStoreError('people store is malformed');
    }
    return parsed;
  };

  const mapSealed = (record, transform) => {
    const next = { ...record };
    for (const [section, fields] of Object.entries(SEALED_FIELDS)) {
      if (!next[section]) continue;
      next[section] = { ...next[section] };
      for (const field of fields) {
        if (next[section][field]) {
          next[section][field] = transform(next[section][field]);
        }
      }
    }
    return next;
  };

  const open = (record) => mapSealed(record, cipher.decrypt);
  const seal = (record) => mapSealed(record, cipher.encrypt);

  const get = (oidInput) => {
    const oid = normalizeOid(oidInput);
    if (!oid) return null;
    const record = readRaw().people[oid];
    return record ? open(record) : null;
  };

  const list = () =>
    Object.values(readRaw().people)
      .map(open)
      .sort((a, b) => String(a.displayName || a.oid).localeCompare(String(b.displayName || b.oid)));

  /**
   * Read-modify-write of one person. `change(current | null)` returns the new
   * plaintext record. Every call here is synchronous, so two requests in the
   * same process cannot interleave between the read and the write.
   */
  const update = (oidInput, change) => {
    const oid = normalizeOid(oidInput);
    if (!oid) throw new PeopleStoreError('invalid Entra object id', 400);
    const store = readRaw();
    const current = store.people[oid] ? open(store.people[oid]) : null;
    const next = change(current);
    store.people[oid] = seal({ ...next, oid, updatedAt: now() });
    store.version = STORE_VERSION;
    writeJsonSecure(filePath, store);
    return open(store.people[oid]);
  };

  /**
   * Creates the person, or refreshes the name and email they sign in with.
   * Called on every bot turn, so an unchanged profile is not rewritten.
   */
  const upsertProfile = ({ oid, displayName, email }) => {
    const current = get(oid);
    const nextName = cleanText(displayName, MAX_DISPLAY_NAME) || current?.displayName || null;
    const nextEmail = cleanText(email, MAX_EMAIL) || current?.email || null;
    if (current && current.displayName === nextName && current.email === nextEmail) {
      return current;
    }
    return update(oid, (existing) => ({
      createdAt: now(),
      allowance: null,
      receive: null,
      ...existing,
      displayName: nextName,
      email: nextEmail,
    }));
  };

  const setAllowanceWallet = (oid, { walletId, adminkey, inkey, source }) =>
    update(oid, (current) => {
      if (!current) throw new PeopleStoreError('unknown person', 404);
      return {
        ...current,
        allowance: { walletId, adminkey, inkey, source, linkedAt: now() },
      };
    });

  const setReceiveTarget = (oid, { lightningAddress = null, inkey = null }) =>
    update(oid, (current) => {
      if (!current) throw new PeopleStoreError('unknown person', 404);
      return {
        ...current,
        receive:
          lightningAddress || inkey
            ? { lightningAddress, inkey, updatedAt: now() }
            : null,
      };
    });

  const findByAllowanceWalletId = (walletId) =>
    list().find((person) => person.allowance?.walletId === walletId) || null;

  return { get, list, upsertProfile, setAllowanceWallet, setReceiveTarget, findByAllowanceWalletId };
};

/**
 * What may leave the server about a person: no key, ever. `receive` says how
 * they receive, and the Lightning address itself (it is a public identifier).
 */
const toPublicPerson = (person) => ({
  oid: person.oid,
  displayName: person.displayName || person.oid,
  email: person.email || '',
  allowanceWalletId: person.allowance?.walletId || null,
  allowanceSource: person.allowance?.source || null,
  receive: {
    lightningAddress: person.receive?.lightningAddress || null,
    invoiceKeyRegistered: Boolean(person.receive?.inkey),
  },
});

let defaultStore = null;
/** The process-wide store, created on first use so tests can set the data dir first. */
const peopleStore = () => {
  if (!defaultStore) defaultStore = createPeopleStore();
  return defaultStore;
};

const resetPeopleStoreForTests = () => {
  defaultStore = null;
};

module.exports = {
  OID_PATTERN,
  PeopleStoreError,
  createPeopleStore,
  normalizeOid,
  peopleStore,
  resetPeopleStoreForTests,
  toPublicPerson,
};
