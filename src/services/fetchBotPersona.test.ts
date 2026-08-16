import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';

const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch as unknown as typeof fetch;
const originalToken = process.env.TAB_BACKEND_TOKEN;
const originalUrl = process.env.WEBSITE_API_URL;

// The module caches the persona at module scope, so each test imports a fresh
// copy to control the cache state.
const freshGetBotPersona = async () => {
  jest.resetModules();
  const { getBotPersona } = await import('./fetchBotPersona');
  return getBotPersona;
};

const okResponse = (persona: string) =>
  ({ ok: true, json: async () => ({ botPersona: persona }) }) as Response;

describe('getBotPersona', () => {
  let consoleError: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
    process.env.WEBSITE_API_URL = 'https://portal.example.test/api';
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    jest.useRealTimers();
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.TAB_BACKEND_TOKEN;
    else process.env.TAB_BACKEND_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.WEBSITE_API_URL;
    else process.env.WEBSITE_API_URL = originalUrl;
  });

  test('authenticates the request and returns the persona string', async () => {
    const getBotPersona = await freshGetBotPersona();
    mockFetch.mockResolvedValue(okResponse('Be concise.'));

    await expect(getBotPersona()).resolves.toBe('Be concise.');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://portal.example.test/api/bot-persona',
      { headers: { Authorization: 'test-internal-token' } },
    );
  });

  test('fails closed before fetch when the internal token is missing', async () => {
    const getBotPersona = await freshGetBotPersona();
    delete process.env.TAB_BACKEND_TOKEN;

    await expect(getBotPersona()).rejects.toThrow('TAB_BACKEND_TOKEN');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('serves from cache within the TTL and refetches after it', async () => {
    jest.useFakeTimers();
    const getBotPersona = await freshGetBotPersona();
    mockFetch.mockResolvedValueOnce(okResponse('First persona.'));

    await expect(getBotPersona()).resolves.toBe('First persona.');
    await expect(getBotPersona()).resolves.toBe('First persona.');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_001);
    mockFetch.mockResolvedValueOnce(okResponse('Updated persona.'));
    await expect(getBotPersona()).resolves.toBe('Updated persona.');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('a failed refresh serves the last known persona and logs, without throwing', async () => {
    jest.useFakeTimers();
    const getBotPersona = await freshGetBotPersona();
    mockFetch.mockResolvedValueOnce(okResponse('Known persona.'));
    await getBotPersona();

    jest.advanceTimersByTime(60_001);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    await expect(getBotPersona()).resolves.toBe('Known persona.');
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('last known persona'),
      expect.objectContaining({ message: expect.stringContaining('429') }),
    );
  });

  test('a failure with no cached persona degrades to the default and backs off for a TTL', async () => {
    jest.useFakeTimers();
    const getBotPersona = await freshGetBotPersona();
    mockFetch.mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(getBotPersona()).resolves.toBe('');
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('default instructions'),
      expect.anything(),
    );

    // The failure is cached too: no fetch-per-turn against a broken portal.
    await expect(getBotPersona()).resolves.toBe('');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_001);
    await getBotPersona();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('a response without a botPersona string degrades instead of poisoning the agent', async () => {
    const getBotPersona = await freshGetBotPersona();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    await expect(getBotPersona()).resolves.toBe('');
    expect(consoleError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        message: expect.stringContaining('no botPersona string'),
      }),
    );
  });
});
