import { decode } from 'light-bolt11-decoder';
import { parseInvoice } from '../utils/lightningInvoice';

jest.mock('light-bolt11-decoder', () => ({ decode: jest.fn() }));

const mockDecode = decode as jest.MockedFunction<typeof decode>;

describe('SendPayment invoice parsing', () => {
  test('reads the exact invoice amount and description', () => {
    mockDecode.mockReturnValue({
      paymentRequest: 'lnbc1invoice',
      sections: [
        { name: 'amount', letters: '20', value: '20000' },
        {
          name: 'description',
          tag: 'd',
          letters: 'thanks',
          value: 'Thanks for the review',
        },
      ],
      expiry: 3600,
      route_hints: [],
    });

    expect(parseInvoice('lnbc1invoice')).toEqual({
      amountSats: 20,
      memo: 'Thanks for the review',
    });
  });

  test('rejects amountless invoices instead of inventing an amount', () => {
    mockDecode.mockReturnValue({
      paymentRequest: 'lnbc1invoice',
      sections: [],
      expiry: 3600,
      route_hints: [],
    });

    expect(() => parseInvoice('lnbc1invoice')).toThrow(
      'The invoice must include an amount.',
    );
  });
});
