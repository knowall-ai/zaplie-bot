// filepath: tabs/backend/githubAppCredentials.js
// Credentials issued by the GitHub App manifest conversion, stored server-side
// only. This module is just the store: githubAppConfig.js chooses between
// these and the GITHUB_* env vars (env wins when set).
const fs = require('fs');
const { dataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');

const STORE_PATH = dataPath('github-app-credentials.json');

const getCredentials = () => {
  if (!fs.existsSync(STORE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (error) {
    // JSON.parse quotes the text around the fault, which here can be the
    // private key or client secret: never pass that on to a log or response.
    throw new Error(`GitHub App credentials store is unreadable (${error.name})`);
  }
};

const saveCredentials = (credentials) => {
  writeJsonSecure(STORE_PATH, credentials);
};

const clearCredentialsForTests = () => {
  fs.rmSync(STORE_PATH, { force: true });
};

module.exports = { getCredentials, saveCredentials, clearCredentialsForTests };
