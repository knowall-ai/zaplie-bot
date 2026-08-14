// Proves the limiter actually enforces HTTP 429, not just that it advertises
// a policy header. Runs in its own process so the tiny limit cannot starve
// the other route suites.
process.env.API_RATE_LIMIT = '3';
process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
process.env.AAD_TENANT_ID = 'test-tenant';
process.env.AAD_CLIENT_ID = 'test-client';

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const http = require('http');

const app = require('./server');

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

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

const get = route =>
  new Promise((resolve, reject) => {
    const req = http.request(`${base}${route}`, { method: 'GET' }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });

test('returns 429 once the request budget is spent', async () => {
  for (let i = 0; i < 3; i++) {
    const response = await get('/api/reward-name');
    assert.equal(response.status, 200);
  }

  const limited = await get('/api/reward-name');
  assert.equal(limited.status, 429);
  assert.match(limited.headers['ratelimit-policy'], /3;w=900/);
});
