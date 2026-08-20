import {
  errorResponse,
  installFetchMock,
  jsonResponse,
} from '../../testUtils/fetchMock';
import { apiRequest } from './gateway';
import { msalInstance } from '../msalClient';

jest.mock('../msalClient', () => ({
  msalInstance: {
    getActiveAccount: jest.fn(),
    getAllAccounts: jest.fn(),
    acquireTokenSilent: jest.fn(),
  },
}));

const mockMsal = msalInstance as unknown as {
  getActiveAccount: jest.Mock;
  getAllAccounts: jest.Mock;
  acquireTokenSilent: jest.Mock;
};

describe('lnbits gateway', () => {
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    mockFetch = installFetchMock();
    mockMsal.getActiveAccount.mockReturnValue({ localAccountId: 'aad-1' });
    mockMsal.getAllAccounts.mockReturnValue([]);
    mockMsal.acquireTokenSilent.mockResolvedValue({
      idToken: 'entra-id-token',
    });
  });

  test('calls a same-origin path with an Entra token and no LNbits key', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([{ id: 'wallet-1' }]));

    await expect(apiRequest('/wallets')).resolves.toEqual([{ id: 'wallet-1' }]);

    expect(mockFetch).toHaveBeenCalledWith('/api/lnbits/wallets', {
      signal: expect.any(AbortSignal),
      headers: { Authorization: 'Bearer entra-id-token' },
    });
    expect(JSON.stringify(mockFetch.mock.calls)).not.toMatch(/X-Api-Key/i);
  });

  test('sends JSON bodies with a content type', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await apiRequest('/zaps', {
      method: 'POST',
      body: JSON.stringify({ amount: 10 }),
    });

    expect(mockFetch.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer entra-id-token',
        'Content-Type': 'application/json',
      },
    });
  });

  test('fails loudly when nobody is signed in', async () => {
    mockMsal.getActiveAccount.mockReturnValue(null);

    await expect(apiRequest('/wallets')).rejects.toThrow('Sign in is required');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('surfaces the error the gateway reports', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Wallet does not belong to this account' }),
    } as unknown as Response);

    await expect(apiRequest('/wallets/w1/payments')).rejects.toThrow(
      'Wallet does not belong to this account',
    );
  });

  test('aborts a stalled request instead of leaving the caller loading', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const { signal } = init as RequestInit;
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
          // Advancing here guarantees the timeout was already scheduled.
          jest.advanceTimersByTime(30_000);
        }),
    );

    await expect(apiRequest('/wallets/w1/payments')).rejects.toThrow(
      'Request timed out after 30000ms',
    );

    jest.useRealTimers();
  });

  test('falls back to the status when the gateway sends no JSON', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500));

    await expect(apiRequest('/wallets')).rejects.toThrow(
      'Request failed with status 500',
    );
  });
});
