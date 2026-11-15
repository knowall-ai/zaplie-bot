// filepath: tabs/backend/connectionsStore.js
// Maps a Zaplie person (Entra oid) to the GitHub App installation they created
// when selecting repositories. Gitignored — see connections.json.
const fs = require('fs');
const { dataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');

// Resolved per call: each organisation has its own file (dataPaths.js).
const storePath = () => dataPath('connections.json');

const readStore = () => {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { installations: {} };
    }
    throw error;
  }
};

const writeStore = (store) => {
  writeJsonSecure(storePath(), store);
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
