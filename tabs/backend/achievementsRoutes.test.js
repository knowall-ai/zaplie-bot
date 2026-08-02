jest.mock('./lnbitsAdmin');

// getLnbitsToken runs exactly once per underlying computation, so its call
// count is the cache's hit/miss observable.
describe('getAchievements TTL cache', () => {
  let getAchievements;
  let lnbitsAdmin;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    lnbitsAdmin = require('./lnbitsAdmin');
    lnbitsAdmin.requireLnbitsConfig.mockReturnValue({ nodeUrl: 'http://lnbits.test' });
    lnbitsAdmin.getLnbitsToken.mockResolvedValue('token');
    lnbitsAdmin.lnbitsGet.mockImplementation(async (url) => {
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
    });
    ({ getAchievements } = require('./achievementsRoutes'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('computes achievements for a known person', async () => {
    const result = await getAchievements('aad-1');
    expect(result.summary).toEqual({ earnedCount: 0, totalCount: 6 });
    expect(result.achievements).toHaveLength(6);
    expect(lnbitsAdmin.getLnbitsToken).toHaveBeenCalledTimes(1);
  });

  test('cache hit: a second call within the TTL reuses the first result', async () => {
    const first = await getAchievements('aad-1');
    jest.advanceTimersByTime(14999);
    const second = await getAchievements('aad-1');
    expect(second).toBe(first);
    expect(lnbitsAdmin.getLnbitsToken).toHaveBeenCalledTimes(1);
  });

  test('cache miss: a different aadOid triggers its own computation', async () => {
    await getAchievements('aad-1');
    await getAchievements('aad-2');
    expect(lnbitsAdmin.getLnbitsToken).toHaveBeenCalledTimes(2);
  });

  test('expiration: a call after the TTL recomputes', async () => {
    const first = await getAchievements('aad-1');
    jest.advanceTimersByTime(15000);
    const second = await getAchievements('aad-1');
    expect(second).not.toBe(first);
    expect(lnbitsAdmin.getLnbitsToken).toHaveBeenCalledTimes(2);
  });

  test('concurrent dedupe: parallel calls for the same key share one computation', async () => {
    const [a, b] = await Promise.all([getAchievements('aad-1'), getAchievements('aad-1')]);
    expect(b).toBe(a);
    expect(lnbitsAdmin.getLnbitsToken).toHaveBeenCalledTimes(1);
  });

  test('a rejected computation is not cached', async () => {
    lnbitsAdmin.getLnbitsToken.mockRejectedValueOnce(
      new Error('LNbits auth failed (status: 500)'),
    );
    await expect(getAchievements('aad-1')).rejects.toThrow('LNbits auth failed (status: 500)');
    const result = await getAchievements('aad-1');
    expect(result.summary).toEqual({ earnedCount: 0, totalCount: 6 });
    expect(lnbitsAdmin.getLnbitsToken).toHaveBeenCalledTimes(2);
  });
});
