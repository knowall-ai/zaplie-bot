// filepath: tabs/backend/githubAppCredentials.js
// Credentials issued by the GitHub App manifest conversion. Stored server-side
// only, and read exclusively from this file: there is no env var fallback.
const fs = require('fs');
const { dataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');

const STORE_PATH = dataPath('github-app-credentials.json');

const getCredentials = () => {
  if (!fs.existsSync(STORE_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
};

const saveCredentials = (credentials) => {
  writeJsonSecure(STORE_PATH, credentials);
};

module.exports = { getCredentials, saveCredentials };
