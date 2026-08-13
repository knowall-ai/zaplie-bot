import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { getAchievementsFor } from './fetchAchievements';

const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch as unknown as typeof fetch;
const originalToken = process.env.TAB_BACKEND_TOKEN;
const originalUrl = process.env.WEBSITE_API_URL;

describe('getAchievementsFor', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
    process.env.WEBSITE_API_URL = 'https://portal.example.test/api';
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.TAB_BACKEND_TOKEN;
    else process.env.TAB_BACKEND_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.WEBSITE_API_URL;
    else process.env.WEBSITE_API_URL = originalUrl;
  });

  test('authenticates the request and returns the backend result', async () => {
    const payload = {
      achievements: [],
      summary: { earnedCount: 0, totalCount: 5 },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => payload,
    } as Response);

    await expect(getAchievementsFor('aad user')).resolves.toEqual(payload);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://portal.example.test/api/achievements/for-person?aad=aad%20user',
      { headers: { Authorization: 'test-internal-token' } },
    );
  });

  test('fails closed before fetch when the internal token is missing', async () => {
    delete process.env.TAB_BACKEND_TOKEN;

    await expect(getAchievementsFor('aad-1')).rejects.toThrow(
      'TAB_BACKEND_TOKEN',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('reports backend failures without fabricating achievements', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 } as Response);

    await expect(getAchievementsFor('aad-1')).rejects.toThrow('status: 404');
  });
});
