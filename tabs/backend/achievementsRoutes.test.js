const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LNBITS_NODE_URL = 'http://lnbits.test';
process.env.LNBITS_USERNAME = 'admin';
process.env.LNBITS_PASSWORD = 'pw';

const { computeAchievements, getAchievements } = require('./achievementsRoutes');

// LNbits v1 fixtures: sub-users keyed by AAD object id in external_id, each
// with an Allowance and a Private wallet. Payment listing uses the paginated
// {data, total} shape with ISO time strings, as returned by v1.5.6.
const users = [
  { id: 'u-alice', username: 'alice', external_id: 'aad-alice' },
  { id: 'u-bob', username: 'bob', external_id: 'aad-bob' },
  { id: 'u-carol', username: 'carol', external_id: 'aad-carol' },
  { id: 'u-dave', username: 'dave', external_id: 'aad-dave' },
];

const walletsByUser = {
  'u-alice': [
    { id: 'A-alice', name: 'Allowance' },
    { id: 'P-alice', name: 'Private' },
  ],
  'u-bob': [
    { id: 'A-bob-old', name: 'Allowance', deleted: true },
    { id: 'A-bob', name: 'Allowance' },
    { id: 'P-bob', name: 'Private' },
  ],
  'u-carol': [
    { id: 'A-carol', name: 'Allowance' },
    { id: 'P-carol', name: 'Private' },
  ],
  'u-dave': [
    { id: 'A-dave', name: 'Allowance' },
    { id: 'P-dave', name: 'Private' },
  ],
};

const zap = (key, fromWallet, toWallet, sats, time) => [
  {
    checking_id: `internal_${key}`,
    wallet_id: fromWallet,
    amount: -sats * 1000,
    time,
  },
  { checking_id: key, wallet_id: toWallet, amount: sats * 1000, time },
];

// 2026-01-05, 2026-01-12 and 2026-01-19 are Mondays: three distinct weeks.
const payments = [
  ...zap('z1', 'A-alice', 'P-bob', 1000, '2026-01-05T10:00:00.000Z'),
  ...zap('z2', 'A-alice', 'P-carol', 500, '2026-01-13T10:00:00.000Z'),
  ...zap('z3', 'A-alice', 'P-bob', 600, '2026-01-21T10:00:00.000Z'),
  // Self-zap: both sides owned by dave, must not count.
  ...zap('self', 'A-dave', 'P-dave', 300, '2026-01-06T10:00:00.000Z'),
  // Debit on bob's deleted Allowance wallet: owner unknown, must not count.
  ...zap('ghost', 'A-bob-old', 'P-carol', 400, '2026-01-07T10:00:00.000Z'),
  // External payment with no internal counterpart, must not count.
  {
    checking_id: 'lnurl-out',
    wallet_id: 'A-alice',
    amount: -250000,
    time: '2026-01-08T10:00:00.000Z',
  },
];

let fetchCalls;
const respond = body => ({ ok: true, status: 200, json: async () => body });

const worldFetch = async (url, options = {}) => {
  fetchCalls.push(String(url));
  const path = String(url).replace('http://lnbits.test', '');
  if (path === '/api/v1/auth' && options.method === 'POST') {
    return respond({ access_token: 'test-token' });
  }
  if (path === '/users/api/v1/user') {
    return respond({ data: users });
  }
  const walletMatch = path.match(/^\/users\/api\/v1\/user\/([^/]+)\/wallet$/);
  if (walletMatch) {
    return respond(walletsByUser[walletMatch[1]] || []);
  }
  if (path.startsWith('/api/v1/payments/all/paginated')) {
    const offset = Number(new URL(url).searchParams.get('offset'));
    return respond({
      data: offset === 0 ? payments : [],
      total: payments.length,
    });
  }
  throw new Error(`Unexpected request in test: ${path}`);
};

const originalFetch = global.fetch;
test.beforeEach(() => {
  fetchCalls = [];
  global.fetch = worldFetch;
});
test.after(() => {
  global.fetch = originalFetch;
});

const byId = result =>
  Object.fromEntries(result.achievements.map(a => [a.id, a]));

test('computes sender milestones from matched internal zaps only', async () => {
  const result = await computeAchievements('aad-alice');
  const a = byId(result);

  // The unmatched external debit, the self-zap and the deleted-wallet pair
  // are all excluded: alice sent z1 + z2 + z3 = 2100 sats.
  assert.equal(a['generous-1k'].current, 2100);
  assert.equal(a['generous-1k'].earned, true);
  // 1000 cumulative sats were reached with the very first zap.
  assert.equal(a['generous-1k'].earnedAt, '2026-01-05T10:00:00.000Z');

  assert.equal(a['first-recognition'].earned, true);
  assert.equal(a['first-recognition'].earnedAt, '2026-01-05T10:00:00.000Z');

  // bob and carol only: 2 of 3 distinct teammates.
  assert.equal(a['team-connector'].current, 2);
  assert.equal(a['team-connector'].earned, false);
  assert.equal(a['team-connector'].earnedAt, null);

  // Three distinct ISO weeks, earned with the third week's first zap.
  assert.equal(a['regular-recogniser'].current, 3);
  assert.equal(a['regular-recogniser'].earnedAt, '2026-01-21T10:00:00.000Z');

  assert.equal(a['well-recognised'].current, 0);
  assert.deepEqual(result.summary, { earnedCount: 3, totalCount: 5 });
});

test('computes recipient milestones without counting excluded pairs', async () => {
  const result = await computeAchievements('aad-bob');
  const a = byId(result);

  // bob received z1 (1000) + z3 (600); the deleted-wallet pair adds nothing.
  assert.equal(a['well-recognised'].current, 1600);
  assert.equal(a['well-recognised'].earnedAt, '2026-01-05T10:00:00.000Z');
  assert.equal(a['first-recognition'].earned, false);
  assert.deepEqual(result.summary, { earnedCount: 1, totalCount: 5 });
});

test('self-zaps earn nothing for the sender', async () => {
  const result = await computeAchievements('aad-dave');
  assert.deepEqual(result.summary, { earnedCount: 0, totalCount: 5 });
});

test('returns null for a person with no LNbits account', async () => {
  assert.equal(await computeAchievements('aad-nobody'), null);
});

test('requests further pages until a short batch arrives', async () => {
  const fullPage = Array.from({ length: 500 }, (_, i) => ({
    checking_id: `filler-${i}`,
    wallet_id: 'A-alice',
    amount: -1000,
    time: '2026-01-02T10:00:00.000Z',
  }));
  const pageTwo = zap('deep', 'A-carol', 'P-alice', 50, '2026-01-09T10:00:00.000Z');
  global.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.includes('/api/v1/payments/all/paginated')) {
      fetchCalls.push(path);
      const offset = Number(new URL(url).searchParams.get('offset'));
      return respond({ data: offset === 0 ? fullPage : pageTwo, total: 502 });
    }
    return worldFetch(url, options);
  };

  const result = await computeAchievements('aad-carol');
  const paymentPages = fetchCalls.filter(u => u.includes('/payments/all/'));
  assert.equal(paymentPages.length, 2);
  assert.match(paymentPages[1], /offset=500/);
  // The zap found on the second page is counted.
  assert.equal(byId(result)['first-recognition'].earned, true);
});

test('fails loudly when the payments response has no data array', async () => {
  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/api/v1/payments/all/paginated')) {
      return respond({ payments });
    }
    return worldFetch(url, options);
  };

  await assert.rejects(computeAchievements('aad-alice'), /no data array/);
});

test('fails loudly on a zap payment with an unparseable time', async () => {
  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/api/v1/payments/all/paginated')) {
      return respond({ data: zap('bad', 'A-alice', 'P-bob', 100, 'not-a-date') });
    }
    return worldFetch(url, options);
  };

  await assert.rejects(computeAchievements('aad-alice'), /unparseable time/);
});

test('caches results within the TTL', async () => {
  await getAchievements('aad-cache-hit');
  const callsAfterFirst = fetchCalls.length;
  await getAchievements('aad-cache-hit');
  assert.equal(fetchCalls.length, callsAfterFirst);
});

test('evicts a rejected computation so the next call retries', async () => {
  global.fetch = async () => {
    throw new Error('lnbits is down');
  };
  await assert.rejects(getAchievements('aad-retry'), /lnbits is down/);

  global.fetch = worldFetch;
  assert.equal(await getAchievements('aad-retry'), null);
});
