// Boots the real Express app on an ephemeral port and checks who can reach
// each config endpoint. The unit suites never covered this: the 401 that broke
// the portal came from route order and middleware, not from any function they
// exercise.
process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
process.env.AAD_TENANT_ID = 'test-tenant';
process.env.AAD_CLIENT_ID = 'test-client';

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ADMIN_TOKEN = 'admin-token';
const USER_TOKEN = 'user-token';

// Seeding require.cache stands in for a mocking framework: server.js pulls
// msalValidator in transitively, and real verification would need live JWKS.
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

// The admin write hits the real data.json, so snapshot it and put it back.
const DATA_FILE = path.join(__dirname, 'data.json');
let dataBackup = null;

const app = require('./server');

let server;
let base;

before(async () => {
  dataBackup = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE) : null;
  await new Promise(resolve => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (dataBackup !== null) {
    fs.writeFileSync(DATA_FILE, dataBackup);
  }
});

const call = (method, route, auth, body) =>
  new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${route}`,
      {
        method,
        headers: {
          ...(auth ? { Authorization: auth } : {}),
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      res => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const get = (route, auth) => call('GET', route, auth);
const post = (route, auth, body) => call('POST', route, auth, body);

const PROTECTED_READS = ['/api/automations', '/api/reward-amounts'];

test('healthz provides an anonymous liveness signal for deployment smoke tests', async () => {
  assert.equal((await get('/healthz')).status, 200);
});

test('reward-name is readable without credentials, since the portal reads it before sign-in', async () => {
  const response = await get('/api/reward-name');
  assert.equal(response.status, 200);
  assert.match(response.headers['ratelimit-policy'], /300;w=900/);
});

for (const route of PROTECTED_READS) {
  test(`${route} rejects an anonymous read`, async () => {
    assert.equal((await get(route)).status, 401);
  });

  test(`${route} accepts a signed-in portal user`, async () => {
    assert.equal((await get(route, `Bearer ${USER_TOKEN}`)).status, 200);
  });

  test(`${route} accepts the bot shared token`, async () => {
    assert.equal((await get(route, 'test-internal-token')).status, 200);
  });

  test(`${route} rejects a wrong-length token without crashing`, async () => {
    assert.equal((await get(route, 'nope')).status, 401);
  });
}

test('a non-admin cannot write the reward name', async () => {
  const res = await post('/api/reward-name', `Bearer ${USER_TOKEN}`, {
    newRewardName: 'points',
  });
  assert.equal(res.status, 403);
});

test('an admin can write the reward name', async () => {
  const res = await post('/api/reward-name', `Bearer ${ADMIN_TOKEN}`, {
    newRewardName: 'points',
  });
  assert.equal(res.status, 200);
});

test('an anonymous write is rejected', async () => {
  const res = await post('/api/reward-name', null, {
    newRewardName: 'points',
  });
  assert.equal(res.status, 401);
});
