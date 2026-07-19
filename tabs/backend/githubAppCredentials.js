// filepath: tabs/backend/githubAppCredentials.js
// Credentials issued by the GitHub App manifest conversion. Stored server-side
// only; env vars remain as a fallback for apps registered by hand.
const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'github-app-credentials.json');

const getCredentials = () => {
  if (!fs.existsSync(STORE_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
};

const saveCredentials = (credentials) => {
  fs.writeFileSync(STORE_PATH, JSON.stringify(credentials, null, 2));
};

module.exports = { getCredentials, saveCredentials };
