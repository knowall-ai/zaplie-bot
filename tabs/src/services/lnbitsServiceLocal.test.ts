// lnbitsServiceLocal.test.ts
import {
  getAccessToken,
  getWallets,
  getUserWallets,
  createInvoice,
  payInvoice,
} from './lnbitsServiceLocal'; // Adjust the path if necessary
import {
  expect,
  describe,
  test,
  beforeAll,
  beforeEach,
  jest,
} from '@jest/globals';

// Install a jest mock in place of the global fetch so tests can stub responses.
global.fetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

// Build a minimal Response-like object for a successful JSON reply.
const jsonResponse = (body: unknown): Response =>
  ({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => body,
  }) as unknown as Response;

describe('lnbitsServiceLocal Tests', () => {
  const mockAccessToken = 'mockedAccessToken';
  const mockInKey = 'mockedInKey';
  const mockAdminKey = 'mockedAdminKey';
  const mockPaymentRequest = 'lnbc1...';
  const mockPaymentResult: { payment_hash: string } = {
    payment_hash: '123abc',
  };
  const mockWallets: { id: string; name: string }[] = [
    { id: 'wallet1', name: 'testWallet' },
  ];
  const mockUserWallets: { id: string; name: string }[] = [
    { id: 'wallet1', name: 'userWallet' },
  ];

  // Prime the in-memory access-token cache once. getAccessToken caches the token
  // after the first successful request, so the remaining tests can focus on their
  // own endpoint calls without each having to stub the auth round-trip.
  beforeAll(async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: mockAccessToken }),
    );
    await getAccessToken('user', 'password');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getAccessToken returns the cached token without calling the API', async () => {
    const token = await getAccessToken('user', 'password');
    expect(token).toBe(mockAccessToken);
    expect(mockFetch).not.toHaveBeenCalled(); // Cached token, so no API call
  });

  test('getWallets should return a filtered list of wallets', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(mockWallets));

    const result = await getWallets();
    expect(result).toEqual(mockWallets);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
    );
  });

  test('getUserWallets should return user wallets', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(mockUserWallets));

    const result = await getUserWallets(mockAdminKey, 'userId');
    // getUserWallets maps the raw response onto the Wallet interface, so assert
    // on the identifying fields rather than a strict deep-equality match.
    expect(result?.[0].id).toBe('wallet1');
    expect(result?.[0].name).toBe('userWallet');
    expect(mockFetch).toHaveBeenCalled();
  });

  test('createInvoice should create an invoice and return the payment request', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ payment_request: mockPaymentRequest }),
    );

    const paymentRequest = await createInvoice(
      mockInKey,
      'walletId',
      1000,
      'test memo',
    );
    expect(paymentRequest).toBe(mockPaymentRequest);
    expect(mockFetch).toHaveBeenCalled();
  });

  test('payInvoice should resolve the payment successfully', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(mockPaymentResult));

    const result = await payInvoice(mockAdminKey, 'paymentRequest');
    expect(result).toEqual(mockPaymentResult);
    expect(mockFetch).toHaveBeenCalled();
  });
});
