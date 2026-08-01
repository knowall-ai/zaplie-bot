// filepath: tabs/backend/identityStore.js
// Person graph: github:providerId (numeric, never the login) <-> personAad (Entra oid).
// Gitignored — see identities.json.
const fs = require('fs');
const path = require('path');
const { writeJsonSecure } = require('./secureJsonStore');

const STORE_PATH = path.join(__dirname, 'identities.json');

const readStore = () => {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { identities: [] };
    }
    throw error;
  }
};

const writeStore = (store) => {
  writeJsonSecure(STORE_PATH, store);
};

const findByProviderId = (provider, providerId) => {
  const store = readStore();
  return (
    store.identities.find(
      (identity) =>
        identity.provider === provider && identity.providerId === providerId,
    ) || null
  );
};

const findByPersonAad = (personAad) => {
  const store = readStore();
  return store.identities.filter((identity) => identity.personAad === personAad);
};

// Enforces (provider, providerId) uniqueness: a github id already linked to
// someone else is a conflict, never silently reassigned.
const linkIdentity = ({ provider, providerId, providerHandle, personAad }) => {
  const store = readStore();
  const existing = store.identities.find(
    (identity) => identity.provider === provider && identity.providerId === providerId,
  );
  if (existing && existing.personAad !== personAad) {
    const error = new Error(
      `${provider} account ${providerId} is already linked to a different person`,
    );
    error.statusCode = 409;
    throw error;
  }
  if (existing) {
    existing.providerHandle = providerHandle;
    existing.linkedAt = new Date().toISOString();
    writeStore(store);
    return existing;
  }
  const identity = {
    provider,
    providerId,
    providerHandle,
    personAad,
    linkMethod: 'oauth',
    verified: true,
    linkedAt: new Date().toISOString(),
  };
  store.identities.push(identity);
  writeStore(store);
  return identity;
};

module.exports = { findByProviderId, findByPersonAad, linkIdentity };
