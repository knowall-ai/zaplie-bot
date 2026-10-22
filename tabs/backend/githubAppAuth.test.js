const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-github-auth-'));
process.env.ZAPLIE_DATA_DIR = tempDir;
delete process.env.GITHUB_APP_ID;
delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;

const {
  saveCredentials,
  clearCredentialsForTests,
} = require('./githubAppCredentials');
const { createAppJwt } = require('./githubAppAuth');

// GitHub issues PKCS1 keys; sign with the same shape.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

beforeEach(() => {
  clearCredentialsForTests();
});

after(() => {
  delete process.env.ZAPLIE_DATA_DIR;
  const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(path.resolve(tempDir).startsWith(safePrefix), true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('createAppJwt signs with the stored manifest key when no env is set', () => {
  saveCredentials({ appId: '1001', slug: 'zaplie-rewards-abcd', pem: privateKey });

  const jwt = createAppJwt();

  const [header, payload, signature] = jwt.split('.');
  const verified = crypto
    .createVerify('RSA-SHA256')
    .update(`${header}.${payload}`)
    .verify(publicKey, signature, 'base64url');
  assert.equal(verified, true);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(claims.iss, '1001');
  assert.ok(claims.exp > claims.iat);
});

test('createAppJwt signs with an env key even when the store is corrupt', () => {
  const keyPath = path.join(tempDir, 'env-key.pem');
  fs.writeFileSync(keyPath, privateKey);
  fs.writeFileSync(path.join(tempDir, 'github-app-credentials.json'), '{"pem');
  process.env.GITHUB_APP_ID = '42';
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
  try {
    const [, payload] = createAppJwt().split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    assert.equal(claims.iss, '42');
  } finally {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  }
  // Without the env group the store is needed, and its error is generic.
  assert.throws(createAppJwt, /credentials store is unreadable \(SyntaxError\)$/);
});

test('createAppJwt throws the 409 setup pointer before the app exists', () => {
  assert.throws(createAppJwt, (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /GitHub app not created yet/);
    return true;
  });
});
