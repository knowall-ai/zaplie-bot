// filepath: tabs/backend/githubAppAuth.js
// GitHub App auth: mint the App JWT, exchange it for an installation token, and
// list the repos the installer selected. RS256 signing uses Node's built-in
// crypto (the private key GitHub issues is PKCS1, which crypto signs directly).
const crypto = require('crypto');
const { requestTimeoutSignal } = require('./httpTimeout');
const { requireGithubApp } = require('./githubAppConfig');

const base64url = (input) => Buffer.from(input).toString('base64url');

const createAppJwt = () => {
  const { appId, privateKeyPem } = requireGithubApp();

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
      signal: requestTimeoutSignal(),
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
      signal: requestTimeoutSignal(),
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

const appRequest = (url) =>
  fetch(url, {
    headers: {
      Authorization: `Bearer ${createAppJwt()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'zaplie-connections',
    },
    signal: requestTimeoutSignal(),
  });

// GET /app/installations/{id} with the App JWT: the installation's account
// login, or null when GitHub answers 404 (not an installation of this App).
// Anything else (network, 5xx, bad credentials) throws, so the caller can tell
// "not ours" from "could not check".
const findAppInstallation = async (installationId) => {
  const response = await appRequest(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`installation lookup failed: ${response.status}`);
  }
  const body = await response.json();
  const accountLogin = body.account?.login;
  if (typeof accountLogin !== 'string' || accountLogin.length === 0) {
    throw new Error('installation lookup returned no account login');
  }
  return { accountLogin };
};

// The login of the account that owns the App. The manifest flow stores it; an
// env-configured App is asked once (GET /app) and cached per App id.
const ownerLoginCache = new Map();

const getAppOwnerLogin = async () => {
  const { appId, ownerLogin } = requireGithubApp();
  if (ownerLogin) {
    return ownerLogin;
  }
  if (ownerLoginCache.has(appId)) {
    return ownerLoginCache.get(appId);
  }
  const response = await appRequest('https://api.github.com/app');
  if (!response.ok) {
    throw new Error(`App lookup failed: ${response.status}`);
  }
  const body = await response.json();
  const login = body.owner?.login;
  if (typeof login !== 'string' || login.length === 0) {
    throw new Error('App lookup returned no owner login');
  }
  ownerLoginCache.set(appId, login);
  return login;
};

module.exports = {
  createAppJwt,
  getInstallationToken,
  listInstallationRepos,
  findAppInstallation,
  getAppOwnerLogin,
};
