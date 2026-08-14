const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, test } = require('node:test');

const lnbitsAdmin = require('./lnbitsAdmin');
const achievementsRoutesPath = require.resolve('./achievementsRoutes');
const originalLnbitsAdmin = { ...lnbitsAdmin };
const originalDateNow = Date.now;

describe('getAchievements TTL cache', () => {
  let getAchievements;
  let getTokenCalls;
  let failNextTokenRequest;
  let now;

  beforeEach(() => {
    getTokenCalls = 0;
    failNextTokenRequest = false;
    now = 1_700_000_000_000;
    Date.now = () => now;

    Object.assign(lnbitsAdmin, {
      requireLnbitsConfig: () => ({ nodeUrl: 'http://lnbits.test' }),
      getLnbitsToken: async () => {
        getTokenCalls += 1;
        if (failNextTokenRequest) {
          failNextTokenRequest = false;
          throw new Error('LNbits auth failed (status: 500)');
        }
        return 'token';
      },
      lnbitsGet: async (url) => {
        if (url === 'http://lnbits.test/users/api/v1/user') {
          return {
            data: [
              { id: 'u1', external_id: 'aad-1' },
              { id: 'u2', external_id: 'aad-2' },
            ],
          };
        }
        if (url.includes('/wallet')) {
          return [];
        }
        if (url.includes('/api/v1/payments/all/paginated')) {
          return [];
        }
        throw new Error(`unexpected lnbitsGet url: ${url}`);
      },
    });

    delete require.cache[achievementsRoutesPath];
    ({ getAchievements } = require('./achievementsRoutes'));
  });

  afterEach(() => {
    Date.now = originalDateNow;
    Object.assign(lnbitsAdmin, originalLnbitsAdmin);
    delete require.cache[achievementsRoutesPath];
  });

  test('computes achievements for a known person', async () => {
    const result = await getAchievements('aad-1');
    assert.deepEqual(result.summary, { earnedCount: 0, totalCount: 6 });
    assert.equal(result.achievements.length, 6);
    assert.equal(getTokenCalls, 1);
  });

  test('cache hit: a second call within the TTL reuses the first result', async () => {
    const first = await getAchievements('aad-1');
    now += 14_999;
    const second = await getAchievements('aad-1');
    assert.strictEqual(second, first);
    assert.equal(getTokenCalls, 1);
  });

  test('cache miss: a different aadOid triggers its own computation', async () => {
    await getAchievements('aad-1');
    await getAchievements('aad-2');
    assert.equal(getTokenCalls, 2);
  });

  test('expiration: a call after the TTL recomputes', async () => {
    const first = await getAchievements('aad-1');
    now += 15_000;
    const second = await getAchievements('aad-1');
    assert.notStrictEqual(second, first);
    assert.equal(getTokenCalls, 2);
  });

  test('concurrent dedupe: parallel calls for the same key share one computation', async () => {
    const [first, second] = await Promise.all([
      getAchievements('aad-1'),
      getAchievements('aad-1'),
    ]);
    assert.strictEqual(second, first);
    assert.equal(getTokenCalls, 1);
  });

  test('a rejected computation is not cached', async () => {
    failNextTokenRequest = true;
    await assert.rejects(
      getAchievements('aad-1'),
      /LNbits auth failed \(status: 500\)/,
    );
    const result = await getAchievements('aad-1');
    assert.deepEqual(result.summary, { earnedCount: 0, totalCount: 6 });
    assert.equal(getTokenCalls, 2);
  });
});
