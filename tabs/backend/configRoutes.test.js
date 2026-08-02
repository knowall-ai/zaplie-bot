// Boots the real Express app on an ephemeral port and checks who can reach
// each config endpoint. The unit suites never covered this: the 401 that broke
// the portal came from route order and middleware, not from any function they
// exercise.
process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
process.env.AAD_TENANT_ID = 'test-tenant';
process.env.AAD_CLIENT_ID = 'test-client';

const ADMIN_TOKEN = 'admin-token';
const USER_TOKEN = 'user-token';

jest.mock('./msalValidator', () => {
  const claimsFor = token => {
    if (token !== 'admin-token' && token !== 'user-token') {
      throw new Error('invalid token');
    }
    return { oid: 'oid-1', roles: token === 'admin-token' ? ['Zaplie.Admin'] : [] };
  };
  return {
    verifyMsalPayload: async token => claimsFor(token),
    verifyMsalToken: async token => claimsFor(token).oid,
    verifyMsalClaims: async token => claimsFor(token),
    extractBearerToken: req => {
      const header = req.headers['authorization'] || '';
      return header.startsWith('Bearer ') ? header.slice(7) : null;
    },
  };
});

const fs = require('fs');
const path = require('path');

// The admin write hits the real data.json, so snapshot it and put it back.
const DATA_FILE = path.join(__dirname, 'data.json');
let dataBackup;

const app = require('./server');

let server;
let base;

beforeAll(async () => {
  dataBackup = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE) : null;
  await new Promise(resolve => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  if (dataBackup !== null) {
    fs.writeFileSync(DATA_FILE, dataBackup);
  }
});

// Jest's node environment does not expose global fetch here, so use node:http.
const http = require('http');

const call = (method, path, auth, body) =>
  new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          ...(auth ? { Authorization: auth } : {}),
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      res => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const get = (path, auth) => call('GET', path, auth);
const post = (path, auth, body) => call('POST', path, auth, body);

const PROTECTED_READS = ['/api/automations', '/api/reward-amounts'];

describe('config endpoint access matrix', () => {
  test('reward-name is readable without credentials, since the portal reads it before sign-in', async () => {
    expect((await get('/api/reward-name')).status).toBe(200);
  });

  test.each(PROTECTED_READS)('%s rejects an anonymous read', async route => {
    expect((await get(route)).status).toBe(401);
  });

  test.each(PROTECTED_READS)('%s accepts a signed-in portal user', async route => {
    expect((await get(route, `Bearer ${USER_TOKEN}`)).status).toBe(200);
  });

  test.each(PROTECTED_READS)('%s accepts the bot shared token', async route => {
    expect((await get(route, 'test-internal-token')).status).toBe(200);
  });

  test.each(PROTECTED_READS)(
    '%s rejects a wrong-length token without crashing',
    async route => {
      expect((await get(route, 'nope')).status).toBe(401);
    },
  );

  test('a non-admin cannot write the reward name', async () => {
    const res = await post('/api/reward-name', `Bearer ${USER_TOKEN}`, {
      newRewardName: 'points',
    });
    expect(res.status).toBe(403);
  });

  test('an admin can write the reward name', async () => {
    const res = await post('/api/reward-name', `Bearer ${ADMIN_TOKEN}`, {
      newRewardName: 'points',
    });
    expect(res.status).toBe(200);
  });

  test('an anonymous write is rejected', async () => {
    const res = await post('/api/reward-name', null, { newRewardName: 'points' });
    expect(res.status).toBe(401);
  });
});
