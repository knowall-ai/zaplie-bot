// filepath: tabs/backend/connectionsStore.js
// Maps a Zaplie person (Entra oid) to the GitHub App installation they created
// when selecting repositories. Gitignored — see connections.json.
const fs = require('fs');
const path = require('path');
const { writeJsonSecure } = require('./secureJsonStore');

const STORE_PATH = path.join(__dirname, 'connections.json');

const readStore = () => {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { installations: {} };
    }
    throw error;
  }
};

const writeStore = (store) => {
  writeJsonSecure(STORE_PATH, store);
};

const setInstallation = (personAad, installationId) => {
  const store = readStore();
  store.installations[personAad] = {
    installationId: String(installationId),
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
};

const getInstallation = (personAad) => {
  const record = readStore().installations[personAad];
  return record ? record.installationId : null;
};

const removeInstallation = (personAad) => {
  const store = readStore();
  delete store.installations[personAad];
  writeStore(store);
};

module.exports = { setInstallation, getInstallation, removeInstallation };
