const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FundKeyPathError,
  createAllowanceExtensionClient,
  isFundKeyPathAllowed,
  readFundKeys,
} = require('./allowanceExtensionClient');
const { resetCachesForTests } = require('./lnbitsGatewayService');

// A fake key shaped like an LNbits key, so the masking is exercised.
const FUND_KEY = 'f'.repeat(32);

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

const installFetch = (handler) => {
  process.env.LNBITS_NODE_URL = 'https://lnbits.test';
  resetCachesForTests();
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const call = {
      path: `${parsed.pathname}${parsed.search}`,
      method: init.method || 'GET',
      key: init.headers?.['X-Api-Key'],
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return calls;
};

test('D7: the Fund key may only reach the exact allowance routes the client uses and the wallet read', () => {
  const allowed = [
    ['GET', '/allowance/api/v1/allowance'],
    ['POST', '/allowance/api/v1/allowance'],
    ['GET', '/allowance/api/v1/allowance/abc'],
    ['PUT', '/allowance/api/v1/allowance/abc'],
    ['DELETE', '/allowance/api/v1/allowance/abc'],
    ['GET', '/allowance/api/v1/health'],
    ['GET', '/api/v1/wallet'],
  ];
  for (const [method, path] of allowed) {
    assert.equal(isFundKeyPathAllowed(method, path), true, `${method} ${path}`);
  }
  const refused = [
    ['POST', '/api/v1/payments'],
    ['GET', '/api/v1/payments'],
    ['POST', '/api/v1/payments/lnurl'],
    ['POST', '/api/v1/wallet'],
    ['PATCH', '/api/v1/wallet'],
    ['GET', '/api/v1/wallets'],
    ['PUT', '/users/api/v1/balance'],
    ['GET', '/allowance/api/v1/../../api/v1/payments'],
    ['GET', '/allowancex/api/v1/allowance'],
    ['GET', '/lnurlp/api/v1/links?x=1#frag'],
    // Admin actions under the extension: a retry pays, so none is allowed.
    ['POST', '/allowance/api/v1/allowance/abc/retry'],
    ['POST', '/allowance/api/v1/test-scheduler'],
    ['GET', '/allowance/api/v1/test-scheduler'],
    ['POST', '/allowance/api/v1/allowance/abc'],
    ['PUT', '/allowance/api/v1/allowance'],
    ['DELETE', '/allowance/api/v1/allowance'],
    ['POST', '/allowance/api/v1/health'],
    ['GET', '/allowance/api/v1/allowance?all_wallets=true'],
    ['GET', '/lnurlp/api/v1/links?all_wallets=false'],
    ['POST', '/lnurlp/api/v1/links'],
    ['GET', undefined],
  ];
  for (const [method, path] of refused) {
    assert.equal(isFundKeyPathAllowed(method, path), false, `${method} ${path}`);
  }
});

test('D7: every client method sends the Fund key only to allowlisted paths, never payments', async () => {
  const calls = installFetch((call) => {
    if (call.path === '/api/v1/wallet') {
      return jsonResponse({ id: 'fund-1', name: 'Fund', balance: 5_000_000, adminkey: 'x' });
    }
    if (call.method === 'GET' && call.path === '/allowance/api/v1/allowance') {
      return jsonResponse([]);
    }
    return jsonResponse({ id: 'row-1', revision: 1 });
  });
  const client = createAllowanceExtensionClient(FUND_KEY);
  await client.fundWallet();
  await client.listAllowances();
  await client.getAllowance('row-1');
  await client.createAllowance({ name: 'zaplie:x' });
  await client.updateAllowance('row-1', 3, { amount: 10 });
  await client.deleteAllowance('row-1');
  await client.health();

  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.equal(call.key, FUND_KEY);
    assert.equal(isFundKeyPathAllowed(call.method, call.path), true, call.path);
    assert.equal(call.path.startsWith('/api/v1/payments'), false);
  }
  assert.deepEqual(calls[4].body, { amount: 10, revision: 3 });
});

test('the client refuses an id that would leave the allowance path', async () => {
  installFetch(() => jsonResponse({}));
  const client = createAllowanceExtensionClient(FUND_KEY);
  await assert.rejects(() => client.deleteAllowance('../../api/v1/payments'), /invalid allowance id/);
});

test('the client exposes no generic request that could carry the Fund key elsewhere', () => {
  const client = createAllowanceExtensionClient(FUND_KEY, {
    request: async () => {
      throw new Error('should not be called');
    },
  });
  assert.deepEqual(Object.keys(client).sort(), [
    'createAllowance',
    'deleteAllowance',
    'fundWallet',
    'getAllowance',
    'health',
    'listAllowances',
    'updateAllowance',
  ]);
  assert.equal(typeof FundKeyPathError, 'function');
});

test('fundWallet returns id, name and balance only, never keys', async () => {
  installFetch(() =>
    jsonResponse({ id: 'fund-1', name: 'Fund', balance: 1_234_567, adminkey: 'a', inkey: 'b' }),
  );
  const info = await createAllowanceExtensionClient(FUND_KEY).fundWallet();
  assert.deepEqual(info, { id: 'fund-1', name: 'Fund', balanceSats: 1234 });
});

test('errors carry the upstream status and detail with keys masked', async () => {
  installFetch(() =>
    jsonResponse({ detail: `Maximum 100 allowances per wallet ${FUND_KEY}` }, 422),
  );
  const client = createAllowanceExtensionClient(FUND_KEY);
  const error = await client.createAllowance({}).catch((caught) => caught);
  assert.equal(error.upstreamStatus, 422);
  assert.match(error.upstreamDetail, /Maximum 100/);
  assert.equal(error.upstreamDetail.includes(FUND_KEY), false);
  assert.equal(String(error.message).includes(FUND_KEY), false);
});

test('reads and updates retry on 429 and 5xx; a create retries only on 429', async () => {
  let failures = 2;
  const calls = installFetch((call) => {
    if (failures > 0) {
      failures -= 1;
      return jsonResponse({ detail: 'busy' }, call.method === 'POST' ? 503 : 429);
    }
    return jsonResponse([]);
  });
  const client = createAllowanceExtensionClient(FUND_KEY, { sleep: async () => {} });
  assert.deepEqual(await client.listAllowances(), []);
  assert.equal(calls.length, 3);

  failures = 1;
  const before = calls.length;
  const error = await client.createAllowance({}).catch((caught) => caught);
  assert.equal(error.upstreamStatus, 503);
  assert.equal(calls.length - before, 1, 'a create is not retried after a 5xx');
});

test('the Fund keys are read in order from ALLOWANCE_FUND_ADMINKEY', () => {
  assert.deepEqual(readFundKeys({ ALLOWANCE_FUND_ADMINKEY: ' a , b,,c ' }), ['a', 'b', 'c']);
  assert.deepEqual(readFundKeys({}), []);
  assert.throws(() => createAllowanceExtensionClient(''), /not configured/);
});
