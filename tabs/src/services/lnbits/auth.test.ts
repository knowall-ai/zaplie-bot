import {
  errorResponse,
  installFetchMock,
  jsonResponse,
  textResponse,
} from '../../testUtils/fetchMock';

const TOKEN_KEY = 'accessToken';
const TOKEN_TIMESTAMP_KEY = 'accessTokenTimestamp';

// auth caches the token in module scope and reads sessionStorage on import, so
// every test needs a fresh copy of the module after seeding sessionStorage.
const loadAuth = async (): Promise<typeof import('./auth')> => {
  jest.resetModules();
  return import('./auth');
};

describe('lnbits auth', () => {
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    sessionStorage.clear();
    mockFetch = installFetchMock();
  });

  test('requests a token and stores it in sessionStorage', async () => {
    const { getAccessToken } = await loadAuth();
    mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'token-1' }));

    await expect(getAccessToken('user', 'password')).resolves.toBe('token-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('token-1');
    expect(sessionStorage.getItem(TOKEN_TIMESTAMP_KEY)).not.toBeNull();
  });

  test('serves later calls from the in-memory token', async () => {
    const { getAccessToken } = await loadAuth();
    mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'token-1' }));

    await getAccessToken('user', 'password');
    await expect(getAccessToken('user', 'password')).resolves.toBe('token-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('reuses an in-flight token request', async () => {
    const { getAccessToken } = await loadAuth();
    mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'token-1' }));

    const [first, second] = await Promise.all([
      getAccessToken('user', 'password'),
      getAccessToken('user', 'password'),
    ]);

    expect(first).toBe('token-1');
    expect(second).toBe('token-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('reuses a token left in sessionStorage by an earlier render', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'stored-token');
    sessionStorage.setItem(TOKEN_TIMESTAMP_KEY, Date.now().toString());

    const { getAccessToken } = await loadAuth();

    await expect(getAccessToken('user', 'password')).resolves.toBe(
      'stored-token',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('discards a stored token older than 24 hours', async () => {
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    sessionStorage.setItem(TOKEN_KEY, 'stale-token');
    sessionStorage.setItem(TOKEN_TIMESTAMP_KEY, twentyFiveHoursAgo.toString());

    const { getAccessToken } = await loadAuth();
    mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'fresh' }));

    await expect(getAccessToken('user', 'password')).resolves.toBe('fresh');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('fresh');
  });

  test('throws when the auth endpoint rejects the credentials', async () => {
    const { getAccessToken } = await loadAuth();
    mockFetch.mockResolvedValueOnce(errorResponse(401, 'Unauthorized'));

    await expect(getAccessToken('user', 'password')).rejects.toMatchObject({
      message: 'Failed to retrieve access token',
      cause: expect.objectContaining({
        message: expect.stringContaining('status: 401'),
      }),
    });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  test('throws when the response is not JSON', async () => {
    const { getAccessToken } = await loadAuth();
    mockFetch.mockResolvedValueOnce(textResponse('<html>login</html>'));

    await expect(getAccessToken('user', 'password')).rejects.toThrow(
      'Failed to retrieve access token',
    );
  });

  test('throws when the payload carries no access_token', async () => {
    const { getAccessToken } = await loadAuth();
    mockFetch.mockResolvedValueOnce(jsonResponse({ detail: 'nope' }));

    await expect(getAccessToken('user', 'password')).rejects.toThrow(
      'Failed to retrieve access token',
    );
  });

  test('retries after a failure instead of reusing the rejected request', async () => {
    const { getAccessToken } = await loadAuth();
    mockFetch.mockResolvedValueOnce(errorResponse(500));

    await expect(getAccessToken('user', 'password')).rejects.toThrow();

    mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'token-2' }));
    await expect(getAccessToken('user', 'password')).resolves.toBe('token-2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
