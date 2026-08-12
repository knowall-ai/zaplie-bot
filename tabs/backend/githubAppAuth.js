// filepath: tabs/backend/githubAppAuth.js
// GitHub App auth: mint the App JWT, exchange it for an installation token, and
// list the repos the installer selected. RS256 signing uses Node's built-in
// crypto (the private key GitHub issues is PKCS1, which crypto signs directly).
const crypto = require('crypto');
const { getCredentials } = require('./githubAppCredentials');

const base64url = (input) => Buffer.from(input).toString('base64url');

const NOT_CREATED_MESSAGE =
  'GitHub app not created yet: an admin can create it from Automations';

// The manifest flow is the only way to configure GitHub; there is no env path.
const requireAppCredentials = () => {
  const stored = getCredentials();
  if (!stored) {
    throw new Error(NOT_CREATED_MESSAGE);
  }
  return stored;
};

const createAppJwt = () => {
  const { appId, pem: privateKeyPem } = requireAppCredentials();

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privateKeyPem, 'base64url');
  return `${signingInput}.${signature}`;
};

const getInstallationToken = async (installationId) => {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createAppJwt()}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'zaplie-connections',
      },
    },
  );
  if (!response.ok) {
    throw new Error(`installation token request failed: ${response.status}`);
  }
  const body = await response.json();
  return body.token;
};

const nextPageUrl = (linkHeader) => {
  if (!linkHeader) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return match ? match[1] : null;
};

const listInstallationRepos = async (installationId) => {
  const token = await getInstallationToken(installationId);
  const repos = [];
  let url = 'https://api.github.com/installation/repositories?per_page=100';
  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'zaplie-connections',
      },
    });
    if (!response.ok) {
      throw new Error(`installation repositories request failed: ${response.status}`);
    }
    const body = await response.json();
    repos.push(
      ...body.repositories.map((repo) => ({
        id: repo.id,
        fullName: repo.full_name,
        private: repo.private,
        htmlUrl: repo.html_url,
      })),
    );
    url = nextPageUrl(response.headers.get('link'));
  }
  return repos;
};

module.exports = {
  createAppJwt,
  getInstallationToken,
  listInstallationRepos,
  requireAppCredentials,
  NOT_CREATED_MESSAGE,
};
