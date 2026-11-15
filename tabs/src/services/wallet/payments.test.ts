import { apiRequest } from './gateway';
import {
  createInvoice,
  getAllPayments,
  getInvoicePayment,
  getWalletPayments,
  getWalletTransactionsSince,
  payInvoice,
  sendZap,
  newIdempotencyKey,
} from './payments';

jest.mock('./gateway', () => ({
  apiRequest: jest.fn(),
}));

const mockApiRequest = apiRequest as jest.MockedFunction<typeof apiRequest>;

const transaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  checking_id: 'check-1',
  pending: false,
  amount: 1000,
  fee: 12,
  memo: 'Thanks',
  time: 1723500000,
  extra: {},
  wallet_id: 'w1',
  ...overrides,
});

describe('lnbits payments', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
  });

  describe('getWalletPayments', () => {
    test('reads the wallet payments by wallet id', async () => {
      mockApiRequest.mockResolvedValueOnce([transaction()]);

      await expect(getWalletPayments('w1')).resolves.toHaveLength(1);
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/wallets/w1/payments?limit=100',
      );
    });
  });

  describe('getInvoicePayment', () => {
    test('addresses the invoice under its wallet', async () => {
      mockApiRequest.mockResolvedValueOnce({ paid: true });

      await getInvoicePayment('w1', 'invoice-1');

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/wallets/w1/payments/invoice-1',
      );
    });
  });

  describe('getWalletTransactionsSince', () => {
    test('returns every payment when the cut-off is zero', async () => {
      mockApiRequest.mockResolvedValueOnce([
        transaction(),
        transaction({ checking_id: 'check-2', time: 1 }),
      ]);

      await expect(
        getWalletTransactionsSince('w1', 0, null),
      ).resolves.toHaveLength(2);
    });

    test('applies the timestamp cut-off', async () => {
      mockApiRequest.mockResolvedValueOnce([
        transaction({ time: 1723500000 }),
        transaction({ checking_id: 'check-2', time: 1723400000 }),
      ]);

      const transactions = await getWalletTransactionsSince(
        'w1',
        1723450000,
        null,
      );

      expect(transactions).toHaveLength(1);
      expect(transactions[0].checking_id).toBe('check-1');
    });

    test('accepts an ISO timestamp', async () => {
      mockApiRequest.mockResolvedValueOnce([
        transaction({ time: '2026-08-13T00:00:00.000Z' }),
      ]);

      await expect(
        getWalletTransactionsSince('w1', 1, null),
      ).resolves.toHaveLength(1);
    });

    test('filters by the extra field', async () => {
      mockApiRequest.mockResolvedValueOnce([
        transaction({ extra: { tag: 'zap' } }),
        transaction({ checking_id: 'check-2', extra: { tag: 'reward' } }),
      ]);

      const transactions = await getWalletTransactionsSince('w1', 0, {
        tag: 'zap',
      });

      expect(transactions).toHaveLength(1);
      expect(transactions[0].checking_id).toBe('check-1');
    });
  });

  describe('getAllPayments', () => {
    test('passes the paging parameters through', async () => {
      mockApiRequest.mockResolvedValueOnce([transaction()]);

      await getAllPayments(10, 20, 'time', 'asc');

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/payments?limit=10&offset=20&sortby=time&direction=asc',
      );
    });
  });

  describe('createInvoice and payInvoice', () => {
    test('address the wallet by id and never send a key', async () => {
      mockApiRequest
        .mockResolvedValueOnce({ paymentRequest: 'lnbc1invoice' })
        .mockResolvedValueOnce({
          payment_hash: 'hash-1',
          checking_id: 'check-1',
        });

      await expect(createInvoice('w1', 1000, 'memo')).resolves.toBe(
        'lnbc1invoice',
      );
      await expect(payInvoice('w1', 'lnbc1invoice')).resolves.toEqual({
        payment_hash: 'hash-1',
        checking_id: 'check-1',
      });

      expect(mockApiRequest.mock.calls[0][0]).toBe('/wallets/w1/invoices');
      expect(mockApiRequest.mock.calls[1][0]).toBe('/wallets/w1/payments');
      expect(JSON.stringify(mockApiRequest.mock.calls)).not.toMatch(/key/i);
    });
  });

  describe('sendZap', () => {
    test('posts the recipient user id, never a wallet key', async () => {
      mockApiRequest.mockResolvedValueOnce({ payment_hash: 'hash-1' });

      await sendZap('user-2', 21, 'Nice work', 'zap-request-00000001');

      expect(mockApiRequest).toHaveBeenCalledWith('/zaps', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'zap-request-00000001' },
        body: JSON.stringify({
          recipientUserId: 'user-2',
          amount: 21,
          memo: 'Nice work',
        }),
      });
    });

    // The key is required, so a caller that retries must pass the same one.
    test('replays the same key on a retry and a new key after success', async () => {
      mockApiRequest.mockRejectedValueOnce(new Error('Request timed out'));
      await expect(
        sendZap('user-2', 21, 'Nice work', 'zap-request-00000001'),
      ).rejects.toThrow('Request timed out');

      mockApiRequest.mockResolvedValueOnce({ payment_hash: 'hash-1' });
      await sendZap('user-2', 21, 'Nice work', 'zap-request-00000001');

      const keys = mockApiRequest.mock.calls.map(
        call => (call[1] as { headers: Record<string, string> }).headers,
      );
      expect(keys[0]['Idempotency-Key']).toBe('zap-request-00000001');
      expect(keys[1]['Idempotency-Key']).toBe('zap-request-00000001');
    });
  });

  // The generated key has to satisfy the gateway's own key pattern, or every
  // zap the portal sends would be rejected with 400. jsdom has no Web Crypto,
  // so each source is stubbed in turn.
  describe('newIdempotencyKey', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const stubCrypto = (value: unknown) =>
      Object.defineProperty(globalThis, 'crypto', {
        value,
        configurable: true,
        writable: true,
      });

    afterEach(() => {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
      else delete (globalThis as { crypto?: unknown }).crypto;
    });

    test('prefers randomUUID and the gateway accepts it', () => {
      stubCrypto({ randomUUID: () => '123e4567-e89b-12d3-a456-426614174000' });

      expect(newIdempotencyKey()).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(newIdempotencyKey()).toMatch(/^[A-Za-z0-9._~-]{16,128}$/);
    });

    test('falls back to random bytes the gateway accepts', () => {
      stubCrypto({
        getRandomValues: (bytes: Uint8Array) => {
          bytes.forEach((_, index) => {
            bytes[index] = index;
          });
          return bytes;
        },
      });

      expect(newIdempotencyKey()).toBe('000102030405060708090a0b0c0d0e0f');
      expect(newIdempotencyKey()).toMatch(/^[A-Za-z0-9._~-]{16,128}$/);
    });

    test('refuses to mint a key with no Web Crypto', () => {
      stubCrypto(undefined);

      expect(() => newIdempotencyKey()).toThrow('no Web Crypto');
    });
  });
});
