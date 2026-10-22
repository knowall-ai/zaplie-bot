const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-github-config-'));
process.env.ZAPLIE_DATA_DIR = tempDir;

const {
  saveCredentials,
  clearCredentialsForTests,
} = require('./githubAppCredentials');
const {
  GithubAppNotConfiguredError,
  NOT_CONFIGURED_MESSAGE,
  getGithubAppConfig,
  getGithubSetupState,
  portalOrigin,
  portalUrl,
  requireGithubApp,
  requireGithubOAuth,
  requireGithubSlug,
} = require('./githubAppConfig');

const ENV_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_APP_SLUG',
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITHUB_OAUTH_REDIRECT_URI',
  'PORTAL_URL',
];

const ENV_PEM_PATH = path.join(tempDir, 'env-key.pem');
fs.writeFileSync(ENV_PEM_PATH, 'env-pem');

const stored = {
  appId: '1001',
  slug: 'zaplie-rewards-abcd',
  htmlUrl: 'https://github.com/apps/zaplie-rewards-abcd',
  clientId: 'Iv1.stored',
  clientSecret: 'stored-secret',
  webhookSecret: 'stored-webhook',
  pem: 'stored-pem',
  createdAt: '2026-10-21T00:00:00.000Z',
};

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  clearCredentialsForTests();
});

after(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.ZAPLIE_DATA_DIR;
  const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(path.resolve(tempDir).startsWith(safePrefix), true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('env app credentials win over stored ones', () => {
  saveCredentials(stored);
  process.env.GITHUB_APP_ID = '42';
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = ENV_PEM_PATH;

  const config = getGithubAppConfig();

  assert.deepEqual(config.app, { appId: '42', privateKeyPem: 'env-pem' });
  assert.equal(config.source, 'env');
});

test('stored manifest credentials are used when no env is set', () => {
  saveCredentials(stored);

  const config = getGithubAppConfig();

  assert.deepEqual(config.app, { appId: '1001', privateKeyPem: 'stored-pem' });
  assert.equal(config.slug, 'zaplie-rewards-abcd');
  assert.equal(config.oauth.clientId, 'Iv1.stored');
  assert.equal(config.oauth.clientSecret, 'stored-secret');
  assert.equal(config.source, 'manifest');
});

test('a partial env app group is never mixed with stored fields', () => {
  saveCredentials(stored);
  process.env.GITHUB_APP_ID = '42';

  assert.deepEqual(getGithubAppConfig().app, {
    appId: '1001',
    privateKeyPem: 'stored-pem',
  });
});

test('a partial env OAuth group is never mixed with stored fields', () => {
  saveCredentials(stored);
  process.env.GITHUB_OAUTH_CLIENT_ID = 'env-client';

  const { clientId, clientSecret } = requireGithubOAuth();

  assert.equal(clientId, 'Iv1.stored');
  assert.equal(clientSecret, 'stored-secret');
});

test('the OAuth redirect URI is derived from the PORTAL_URL origin', () => {
  saveCredentials(stored);
  process.env.PORTAL_URL = 'https://portal.example.com/settings/';

  assert.equal(
    requireGithubOAuth().redirectUri,
    'https://portal.example.com/api/identities/github/callback',
  );
});

test('an explicit GITHUB_OAUTH_REDIRECT_URI wins', () => {
  process.env.GITHUB_OAUTH_CLIENT_ID = 'env-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'env-secret';
  process.env.GITHUB_OAUTH_REDIRECT_URI = 'https://api.example.com/cb';

  assert.deepEqual(requireGithubOAuth(), {
    clientId: 'env-client',
    clientSecret: 'env-secret',
    redirectUri: 'https://api.example.com/cb',
  });
});

test('the slug comes from env first, then the stored credentials', () => {
  saveCredentials(stored);
  assert.equal(requireGithubSlug(), 'zaplie-rewards-abcd');

  process.env.GITHUB_APP_SLUG = 'env-slug';
  assert.equal(requireGithubSlug(), 'env-slug');
});

test('nothing configured: every require throws the 409 setup pointer', () => {
  assert.equal(getGithubAppConfig().source, null);
  for (const requireGroup of [
    requireGithubApp,
    requireGithubOAuth,
    requireGithubSlug,
  ]) {
    assert.throws(requireGroup, (error) => {
      assert.ok(error instanceof GithubAppNotConfiguredError);
      assert.equal(error.status, 409);
      assert.equal(error.message, NOT_CONFIGURED_MESSAGE);
      return true;
    });
  }
});

test('the setup pointer keeps the wording the zero-config docs promise', () => {
  // A deliberate contract pin, the one literal copy: docs/setup/
  // zero-config-github.md quotes this text, so a change must update both.
  assert.equal(
    NOT_CONFIGURED_MESSAGE,
    'GitHub app not created yet: an admin can create it from Automations',
  );
});

test('a malformed PORTAL_URL only breaks the OAuth group that needs it', () => {
  process.env.PORTAL_URL = 'portal.example.com/settings';

  assert.equal(getGithubAppConfig().oauth, null);
  assert.deepEqual(getGithubSetupState(), {
    source: 'none',
    installationReady: false,
  });

  saveCredentials(stored);
  assert.throws(requireGithubOAuth, TypeError);
  assert.equal(requireGithubSlug(), 'zaplie-rewards-abcd');
  assert.equal(getGithubSetupState().installationReady, true);
});

test('installation readiness needs both the slug and the App key', () => {
  process.env.GITHUB_APP_SLUG = 'env-slug';
  assert.deepEqual(getGithubSetupState(), {
    source: 'env',
    installationReady: false,
  });

  process.env.GITHUB_APP_ID = '42';
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = ENV_PEM_PATH;
  assert.deepEqual(getGithubSetupState(), {
    source: 'env',
    installationReady: true,
  });

  // An unreadable key file is configured but not usable, and creating an App
  // cannot fix it because env wins: the state says so.
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = path.join(tempDir, 'missing.pem');
  assert.deepEqual(getGithubSetupState(), {
    source: 'env',
    installationReady: false,
    envKeyUnreadable: true,
  });
});

test('a corrupt store raises an error that does not quote its contents', () => {
  fs.writeFileSync(
    path.join(tempDir, 'github-app-credentials.json'),
    '{"clientSecret": "SECRETVALUE',
  );
  assert.throws(requireGithubSlug, (error) => {
    assert.doesNotMatch(error.message, /SECRETVALUE/);
    assert.match(error.message, /credentials store is unreadable/);
    return true;
  });
});

test('GITHUB_OAUTH_REDIRECT_URI never applies to the stored manifest client', () => {
  // The manifest client has only its own callback registered on GitHub.
  saveCredentials(stored);
  process.env.PORTAL_URL = 'https://portal.example.com/settings';
  process.env.GITHUB_OAUTH_REDIRECT_URI = 'https://other.example.com/cb';

  assert.equal(
    requireGithubOAuth().redirectUri,
    'https://portal.example.com/api/identities/github/callback',
  );
});

test('a complete env group works even when the store is corrupt', () => {
  fs.writeFileSync(
    path.join(tempDir, 'github-app-credentials.json'),
    '{"pem": "BROKEN',
  );
  process.env.GITHUB_APP_ID = '42';
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = ENV_PEM_PATH;
  process.env.GITHUB_OAUTH_CLIENT_ID = 'env-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'env-secret';
  process.env.GITHUB_APP_SLUG = 'env-slug';

  assert.deepEqual(requireGithubApp(), {
    appId: '42',
    privateKeyPem: 'env-pem',
  });
  assert.equal(requireGithubOAuth().clientId, 'env-client');
  assert.equal(requireGithubSlug(), 'env-slug');

  // A group that needs the store still fails, without quoting it.
  delete process.env.GITHUB_APP_SLUG;
  assert.throws(requireGithubSlug, (error) => {
    assert.match(error.message, /credentials store is unreadable/);
    assert.doesNotMatch(error.message, /BROKEN/);
    return true;
  });
  // The status reader stays strict: it reports stored fields.
  assert.throws(getGithubSetupState, /credentials store is unreadable/);
});

test('an unreadable env key file keeps the existing error text', () => {
  process.env.GITHUB_APP_ID = '42';
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = path.join(tempDir, 'missing.pem');

  assert.throws(requireGithubApp, /failed to read GitHub App private key at/);
  // The slug and OAuth groups do not depend on that file.
  saveCredentials(stored);
  assert.equal(requireGithubSlug(), 'zaplie-rewards-abcd');
});

test('portalUrl strips trailing slashes and portalOrigin drops the path', () => {
  process.env.PORTAL_URL = ' https://portal.example.com/settings// ';
  assert.equal(portalUrl(), 'https://portal.example.com/settings');
  assert.equal(portalOrigin(), 'https://portal.example.com');

  delete process.env.PORTAL_URL;
  assert.equal(portalUrl(), 'https://localhost:3000');
});
