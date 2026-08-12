import {
  getWebhookKeyHashes,
  resetWebhookKeyHashesCache,
} from './fetchWebhookKeys';
import {
  expect,
  describe,
  test,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';

const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch as unknown as typeof fetch;

const okResponse = (hashes: string[]): Response =>
  ({ ok: true, json: async () => ({ hashes }) }) as Response;

describe('getWebhookKeyHashes cache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.TAB_BACKEND_TOKEN = 'test-token-not-placeholder';
    resetWebhookKeyHashesCache();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.TAB_BACKEND_TOKEN;
  });

  test('fetches hashes from the tab backend on first call', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(['h1', 'h2']));
    await expect(getWebhookKeyHashes()).resolves.toEqual(['h1', 'h2']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('serves the cache within the TTL without a second fetch', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(['h1']));
    await getWebhookKeyHashes();

    jest.advanceTimersByTime(29_000);
    await expect(getWebhookKeyHashes()).resolves.toEqual(['h1']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('refetches after the TTL expires', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(['old']));
    await getWebhookKeyHashes();

    jest.advanceTimersByTime(31_000);
    mockFetch.mockResolvedValueOnce(okResponse(['new']));
    await expect(getWebhookKeyHashes()).resolves.toEqual(['new']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('deduplicates concurrent refreshes into a single fetch', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(['h1']));
    const [a, b] = await Promise.all([
      getWebhookKeyHashes(),
      getWebhookKeyHashes(),
    ]);
    expect(a).toEqual(['h1']);
    expect(b).toEqual(['h1']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('serves stale hashes with a warning when the refresh fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(okResponse(['stale']));
    await getWebhookKeyHashes();

    jest.advanceTimersByTime(31_000);
    mockFetch.mockRejectedValueOnce(new Error('backend down'));
    await expect(getWebhookKeyHashes()).resolves.toEqual(['stale']);
    expect(warn).toHaveBeenCalled();
  });

  test('rejects when the refresh fails and the cache is older than the stale window', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(['ancient']));
    await getWebhookKeyHashes();

    jest.advanceTimersByTime(5 * 60_000 + 1);
    mockFetch.mockRejectedValue(new Error('backend down'));
    await expect(getWebhookKeyHashes()).rejects.toThrow('backend down');
  });

  test('fails closed when the first fetch fails and no cache exists', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));
    await expect(getWebhookKeyHashes()).rejects.toThrow('connection refused');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('rejects on a non-2xx response instead of caching it', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 } as Response);
    await expect(getWebhookKeyHashes()).rejects.toThrow(
      'webhook key hashes fetch failed: 502',
    );
  });
});
