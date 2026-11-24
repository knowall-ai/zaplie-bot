// filepath: tabs/backend/peopleStore.js
// Zaplie's own directory: Entra object id -> the person's Allowance wallet
// (owned by zaplie.service, reached only through its NWC connection string,
// plus the zaplie-<oid> Lightning address the allowance extension pays) and
// where they receive zaps: the Lightning address of their own Private wallet.
// It replaces reading LNbits' external_id through the admin Users API.
//
// On disk (people.json under ZAPLIE_DATA_DIR) the NWC connection string is
// sealed by keyCipher.js; callers only ever see it decrypted through
// `get`/`list`, and `toPublicPerson` is the projection anything leaving the
// server goes through.
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
  allowance: ['nwc'],
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

  // False when people.json has never been written (e.g. just after an upgrade
  // from the LNbits-backed directory): the list is then empty because it is
  // unknown, not because nobody is registered.
  const exists = () => fs.existsSync(filePath);

  // Nothing removes a person, so absence from the directory never proves
  // someone left: the list counts as the whole workforce only once an import
  // (or the operator) has marked it complete.
  const isComplete = () => {
    if (!exists()) return false;
    return readRaw().directoryComplete === true;
  };

  const markComplete = () => {
    const store = readRaw();
    store.directoryComplete = true;
    store.version = STORE_VERSION;
    writeJsonSecure(filePath, store);
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

  // `walletId` is the NWC connection id (a hash, see nwcWallet.js), `nwc` the
  // connection string, `lightningAddress` the Allowance wallet's own address.
  const setAllowanceWallet = (oid, { walletId, nwc, lightningAddress, source }) =>
    update(oid, (current) => {
      if (!current) throw new PeopleStoreError('unknown person', 404);
      return {
        ...current,
        allowance: { walletId, nwc, lightningAddress, source, linkedAt: now() },
      };
    });

  const setReceiveTarget = (oid, { lightningAddress = null }) =>
    update(oid, (current) => {
      if (!current) throw new PeopleStoreError('unknown person', 404);
      return {
        ...current,
        receive: lightningAddress ? { lightningAddress, updatedAt: now() } : null,
      };
    });

  const findByAllowanceWalletId = (walletId) =>
    list().find((person) => person.allowance?.walletId === walletId) || null;

  const findByAllowanceAddress = (address) =>
    list().find((person) => person.allowance?.lightningAddress === address) || null;

  return {
    get,
    list,
    exists,
    isComplete,
    markComplete,
    upsertProfile,
    setAllowanceWallet,
    setReceiveTarget,
    findByAllowanceWalletId,
    findByAllowanceAddress,
  };
};

/**
 * What may leave the server about a person: never the NWC connection string.
 * Lightning addresses are public identifiers and are included.
 */
const toPublicPerson = (person) => ({
  oid: person.oid,
  displayName: person.displayName || person.oid,
  email: person.email || '',
  allowanceWalletId: person.allowance?.walletId || null,
  allowanceSource: person.allowance?.source || null,
  allowanceLightningAddress: person.allowance?.lightningAddress || null,
  receive: {
    lightningAddress: person.receive?.lightningAddress || null,
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
