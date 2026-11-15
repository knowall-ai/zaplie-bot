// filepath: tabs/backend/secretsStore.js
// Internal secrets nobody should ever type: env wins when present (existing
// deployments keep their values), otherwise the secret is generated once and
// persisted server-side. The store swaps to Key Vault in Azure (phase 2).
const fs = require('fs');
const crypto = require('crypto');
const { globalDataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');

// One per deployment, shared by every organisation.
const STORE_PATH = globalDataPath('secrets.json');

const readStore = () => {
  if (!fs.existsSync(STORE_PATH)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
};

const getOrCreateSecret = (name, bytes = 32) => {
  const fromEnv = process.env[name];
  if (fromEnv) {
    return fromEnv;
  }
  const store = readStore();
  if (store[name]) {
    return store[name];
  }
  store[name] = crypto.randomBytes(bytes).toString('hex');
  writeJsonSecure(STORE_PATH, store);
  return store[name];
};

module.exports = { getOrCreateSecret };
