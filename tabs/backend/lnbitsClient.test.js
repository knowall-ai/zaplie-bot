const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { lnbitsRequest } = require('./lnbitsClient');

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });

const withEnv = (t, values) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const savedFetch = global.fetch;
  t.after(() => {
    global.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

test('a wallet key goes out as X-Api-Key and nothing else', async (t) => {
  withEnv(t, { LNBITS_URL: 'https://lnbits.test/', LNBITS_API_TOKEN: 'token' });
  let seen;
  global.fetch = async (url, init) => {
    seen = { url, headers: init.headers };
    return ok({});
  };
  await lnbitsRequest('/api/v1/wallet', { walletKey: 'k'.repeat(32) });
  assert.equal(seen.url, 'https://lnbits.test/api/v1/wallet');
  assert.equal(seen.headers['X-Api-Key'], 'k'.repeat(32));
  assert.equal(seen.headers.Authorization, undefined);
});

test('a per-request token goes out as a Bearer token; nothing is read from the environment', async (t) => {
  withEnv(t, { LNBITS_URL: 'https://lnbits.test', LNBITS_API_TOKEN: 'from-env-must-not-be-used' });
  let seen;
  global.fetch = async (_url, init) => {
    seen = init.headers;
    return ok([]);
  };
  await lnbitsRequest('/api/v1/wallets', { bearer: 'pasted-token-0001' });
  assert.equal(seen.Authorization, 'Bearer pasted-token-0001');
  assert.equal(seen['X-Api-Key'], undefined);
});

test('a request with no credential, or two, is never sent', async (t) => {
  withEnv(t, { LNBITS_URL: 'https://lnbits.test', LNBITS_API_TOKEN: 'token' });
  global.fetch = async () => {
    throw new Error('must not be called');
  };
  await assert.rejects(lnbitsRequest('/api/v1/wallet'), /needs a wallet key or a token/);
  await assert.rejects(lnbitsRequest('/api/v1/wallet', { apiToken: true }), /needs a wallet key or a token/);
  await assert.rejects(lnbitsRequest('/api/v1/wallet', { walletKey: 'k', bearer: 'b'.repeat(20) }), /one credential/);
});

test('LNBITS_URL is required (LNBITS_NODE_URL still read for existing settings)', async (t) => {
  withEnv(t, { LNBITS_URL: undefined, LNBITS_NODE_URL: undefined });
  await assert.rejects(lnbitsRequest('/api/v1/wallet', { walletKey: 'k' }), /LNBITS_URL must be set/);
  process.env.LNBITS_NODE_URL = 'https://legacy.test';
  let seen;
  global.fetch = async (url) => {
    seen = url;
    return ok({});
  };
  await lnbitsRequest('/api/v1/wallet', { walletKey: 'k' });
  assert.equal(seen, 'https://legacy.test/api/v1/wallet');
});

// The least-privilege contract, checked against the source itself: no portal
// code path logs in to LNbits or calls the admin Users API.
test('no backend module calls /api/v1/auth or /users/api/v1', () => {
  const offenders = fs
    .readdirSync(__dirname)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
    .filter((name) => {
      // Comments may name the forbidden routes to explain why they are gone.
      const source = fs
        .readFileSync(path.join(__dirname, name), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      return /\/api\/v1\/auth\b|\/users\/api\/v1/.test(source) || /LNBITS_(USERNAME|PASSWORD|ADMINKEY|API_TOKEN)\b|ZAPLIE_AUTO_PROVISION/.test(source);
    });
  assert.deepEqual(offenders, []);
});
