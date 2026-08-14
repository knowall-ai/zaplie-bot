import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { getBotPersona } from './fetchBotPersona';

const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch as unknown as typeof fetch;
const originalToken = process.env.TAB_BACKEND_TOKEN;
const originalUrl = process.env.WEBSITE_API_URL;

describe('getBotPersona', () => {
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

  test('authenticates the request and returns the persona string', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ botPersona: 'Be concise.' }),
    } as Response);

    await expect(getBotPersona()).resolves.toBe('Be concise.');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://portal.example.test/api/bot-persona',
      { headers: { Authorization: 'test-internal-token' } },
    );
  });

  test('fails closed before fetch when the internal token is missing', async () => {
    delete process.env.TAB_BACKEND_TOKEN;

    await expect(getBotPersona()).rejects.toThrow('TAB_BACKEND_TOKEN');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('reports backend failures without inventing a persona', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(getBotPersona()).rejects.toThrow('status: 503');
  });

  test('rejects a response without a botPersona string', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    await expect(getBotPersona()).rejects.toThrow('no botPersona string');
  });
});
