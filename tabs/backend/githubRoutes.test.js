// Boots the real Express app and walks the GitHub routes before and after the
// manifest flow stores credentials, with no GITHUB_* env vars set: the stored
// credentials alone must be enough to install the app and link identities.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-github-routes-'));
process.env.ZAPLIE_DATA_DIR = tempDir;
process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
process.env.AAD_TENANT_ID = 'test-tenant';
process.env.AAD_CLIENT_ID = 'test-client';
// The identity docs point PORTAL_URL at the Settings route; GitHub callbacks
// must still land on the origin.
process.env.PORTAL_URL = 'https://portal.example.com/settings';
for (const key of [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_APP_SLUG',
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITHUB_OAUTH_REDIRECT_URI',
]) {
  delete process.env[key];
}

const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const http = require('http');

const ADMIN_TOKEN = 'admin-token';
const USER_TOKEN = 'user-token';

// Same require.cache stand-in as configRoutes.test.js: real verification
// would need live JWKS.
const claimsFor = token => {
  if (token !== ADMIN_TOKEN && token !== USER_TOKEN) {
    throw new Error('invalid token');
  }
  return { oid: 'oid-1', roles: token === ADMIN_TOKEN ? ['Zaplie.Admin'] : [] };
};

const validatorPath = require.resolve('./msalValidator');
require.cache[validatorPath] = {
  id: validatorPath,
  filename: validatorPath,
  loaded: true,
  exports: {
    verifyMsalPayload: async token => claimsFor(token),
    verifyMsalToken: async token => claimsFor(token).oid,
    verifyMsalClaims: async token => claimsFor(token),
    extractBearerToken: req => {
      const header = req.headers['authorization'] || '';
      return header.startsWith('Bearer ') ? header.slice(7) : null;
    },
  },
};

const {
  saveCredentials,
  clearCredentialsForTests,
} = require('./githubAppCredentials');
const { NOT_CONFIGURED_MESSAGE } = require('./githubAppConfig');
const app = require('./server');

const STORED = {
  appId: '1001',
  slug: 'zaplie-rewards-abcd',
  htmlUrl: 'https://github.com/apps/zaplie-rewards-abcd',
  clientId: 'Iv1.stored',
  clientSecret: 'stored-secret',
  webhookSecret: 'stored-webhook',
  pem: 'stored-pem',
  createdAt: '2026-10-21T00:00:00.000Z',
};

let server;
let base;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  clearCredentialsForTests();
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  delete process.env.ZAPLIE_DATA_DIR;
  const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(path.resolve(tempDir).startsWith(safePrefix), true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const call = (method, route, auth) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${route}`,
      { method, headers: auth ? { Authorization: auth } : {} },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(raw);
          } catch {
            // Redirects and plain-text bodies stay null.
          }
          resolve({ status: res.statusCode, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

test('install-url is admin-only', async () => {
  saveCredentials(STORED);
  const res = await call(
    'POST',
    '/api/connections/github/install-url',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(res.status, 403);
  assert.equal(res.body.installUrl, undefined);
});

test('install-url is a 409 setup pointer before the app is created', async () => {
  const res = await call(
    'POST',
    '/api/connections/github/install-url',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.equal(res.status, 409);
  assert.equal(res.body.error, NOT_CONFIGURED_MESSAGE);
});

test('install-url uses the stored slug once the manifest flow has run', async () => {
  saveCredentials(STORED);
  const res = await call(
    'POST',
    '/api/connections/github/install-url',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.equal(res.status, 200);
  assert.match(
    res.body.installUrl,
    /^https:\/\/github\.com\/apps\/zaplie-rewards-abcd\/installations\/new\?state=/,
  );
});

test('identity authorize-url is a 409 setup pointer before the app is created', async () => {
  const res = await call(
    'POST',
    '/api/identities/github/authorize-url',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(res.status, 409);
  assert.equal(res.body.error, NOT_CONFIGURED_MESSAGE);
});

test('identity authorize-url uses the stored client and the manifest callback', async () => {
  saveCredentials(STORED);
  const res = await call(
    'POST',
    '/api/identities/github/authorize-url',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(res.status, 200);
  const url = new URL(res.body.authorizeUrl);
  assert.equal(url.searchParams.get('client_id'), 'Iv1.stored');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://portal.example.com/api/identities/github/callback',
  );
  // The client secret never reaches the browser.
  assert.doesNotMatch(res.body.authorizeUrl, /stored-secret/);
});

test('setup manifest is admin-only', async () => {
  const res = await call(
    'GET',
    '/api/setup/github/manifest',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(res.status, 403);
});

test('setup manifest registers callbacks on the portal origin', async () => {
  const res = await call(
    'GET',
    '/api/setup/github/manifest',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.equal(res.status, 200);
  const manifest = JSON.parse(res.body.manifest);
  assert.equal(
    manifest.redirect_url,
    'https://portal.example.com/api/setup/github/callback',
  );
  assert.deepEqual(manifest.callback_urls, [
    'https://portal.example.com/api/identities/github/callback',
  ]);
  assert.equal(manifest.hook_attributes, undefined);
});

test('setup manifest refuses to register localhost when PORTAL_URL is unset in production', async () => {
  const portal = process.env.PORTAL_URL;
  const nodeEnv = process.env.NODE_ENV;
  process.env.PORTAL_URL = '  ';
  process.env.NODE_ENV = 'production';
  try {
    const res = await call(
      'GET',
      '/api/setup/github/manifest',
      `Bearer ${ADMIN_TOKEN}`,
    );
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'PORTAL_URL is not set' });
  } finally {
    process.env.PORTAL_URL = portal;
    if (nodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = nodeEnv;
    }
  }
});

test('setup manifest registers under an organisation when one is given', async () => {
  const personal = await call(
    'GET',
    '/api/setup/github/manifest',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.match(
    personal.body.action,
    /^https:\/\/github\.com\/settings\/apps\/new\?state=/,
  );

  const org = await call(
    'GET',
    '/api/setup/github/manifest?organization=knowall-ai',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.equal(org.status, 200);
  assert.match(
    org.body.action,
    /^https:\/\/github\.com\/organizations\/knowall-ai\/settings\/apps\/new\?state=/,
  );
  // Still private: it is installable on the organisation that owns it.
  assert.equal(JSON.parse(org.body.manifest).public, false);

  const empty = await call(
    'GET',
    '/api/setup/github/manifest?organization=',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.match(
    empty.body.action,
    /^https:\/\/github\.com\/settings\/apps\/new/,
  );
});

for (const organization of [
  'evil.com%2F',
  '-leading',
  'trailing-',
  'double--hyphen',
  'a'.repeat(40),
  '..%2F..%2Fsettings',
]) {
  test(`setup manifest rejects the organisation "${organization}"`, async () => {
    const res = await call(
      'GET',
      `/api/setup/github/manifest?organization=${organization}`,
      `Bearer ${ADMIN_TOKEN}`,
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.action, undefined);
  });
}

test('setup status reports where the configuration comes from', async () => {
  const before = await call(
    'GET',
    '/api/setup/github/status',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(before.status, 200);
  assert.deepEqual(before.body, {
    created: false,
    source: 'none',
    installationReady: false,
  });

  saveCredentials(STORED);
  const afterSave = await call(
    'GET',
    '/api/setup/github/status',
    `Bearer ${USER_TOKEN}`,
  );
  assert.deepEqual(afterSave.body, {
    created: true,
    slug: STORED.slug,
    htmlUrl: STORED.htmlUrl,
    source: 'manifest',
    installationReady: true,
  });

  process.env.GITHUB_APP_SLUG = 'env-slug';
  try {
    const withEnv = await call(
      'GET',
      '/api/setup/github/status',
      `Bearer ${USER_TOKEN}`,
    );
    // The stored app signs (its key group is complete); only the slug is env.
    assert.equal(withEnv.body.source, 'manifest');

    const keyPath = path.join(tempDir, 'env-key.pem');
    fs.writeFileSync(keyPath, 'env-pem');
    process.env.GITHUB_APP_ID = '42';
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
    const envApp = await call(
      'GET',
      '/api/setup/github/status',
      `Bearer ${USER_TOKEN}`,
    );
    assert.equal(envApp.body.source, 'env');
    // Non-secret fields only, whichever source is in use.
    assert.doesNotMatch(JSON.stringify(envApp.body), /pem|secret/i);
  } finally {
    delete process.env.GITHUB_APP_SLUG;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  }
});

test('an env slug without an App key is not ready to connect repositories', async () => {
  process.env.GITHUB_APP_SLUG = 'env-slug';
  try {
    const res = await call(
      'GET',
      '/api/setup/github/status',
      `Bearer ${USER_TOKEN}`,
    );
    // The install link would work, but listing the installation's
    // repositories needs the App key, so the portal must not offer it.
    assert.deepEqual(res.body, {
      created: false,
      source: 'env',
      installationReady: false,
    });
  } finally {
    delete process.env.GITHUB_APP_SLUG;
  }
});

test('a corrupt credentials store fails cleanly without echoing its contents', async () => {
  fs.writeFileSync(
    path.join(tempDir, 'github-app-credentials.json'),
    '{"pem": "-----BEGIN RSA PRIVATE KEY----- SECRETKEYMATERIAL',
  );
  const install = await call(
    'POST',
    '/api/connections/github/install-url',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.equal(install.status, 500);
  assert.deepEqual(install.body, {
    error: 'GitHub App configuration is unavailable',
  });

  const status = await call(
    'GET',
    '/api/setup/github/status',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(status.status, 500);

  for (const res of [install, status]) {
    assert.doesNotMatch(JSON.stringify(res.body), /SECRETKEY|PRIVATE KEY/);
  }
});

test('a PORTAL_URL without a scheme does not break status or the callback', async () => {
  process.env.PORTAL_URL = 'portal.example.com/settings';
  try {
    const status = await call(
      'GET',
      '/api/setup/github/status',
      `Bearer ${USER_TOKEN}`,
    );
    assert.equal(status.status, 200);
    assert.equal(status.body.source, 'none');

    const callback = await call(
      'GET',
      '/api/setup/github/callback?code=abc&state=forged',
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.location, '/automations?setup=github_error');

    // The manifest is baked into the App: refuse rather than guess a URL.
    const manifest = await call(
      'GET',
      '/api/setup/github/manifest',
      `Bearer ${ADMIN_TOKEN}`,
    );
    assert.equal(manifest.status, 500);
  } finally {
    process.env.PORTAL_URL = 'https://portal.example.com/settings';
  }
});

test('setup callback with a bad state returns to Automations with an error', async () => {
  const res = await call(
    'GET',
    '/api/setup/github/callback?code=abc&state=forged',
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.location,
    'https://portal.example.com/automations?setup=github_error',
  );
});
