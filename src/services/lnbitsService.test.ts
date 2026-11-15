import {
  expect,
  describe,
  test,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'https://lnbits.test';

const originalFetch = global.fetch;
const originalUrl = process.env.LNBITS_URL;
const originalNodeUrl = process.env.LNBITS_NODE_URL;
const originalToken = process.env.LNBITS_API_TOKEN;

type LnbitsService = typeof import('./lnbitsService');

const fetchMock = jest.fn<typeof fetch>();

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const lastRequest = () => {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: String(call[0]), init: call[1] };
};

let service: LnbitsService;

beforeEach(() => {
  process.env.LNBITS_URL = BASE;
  delete process.env.LNBITS_NODE_URL;
  process.env.LNBITS_API_TOKEN = 'acl-token';
  fetchMock.mockReset();
  fetchMock.mockImplementation(async input => {
    throw new Error(`Unexpected fetch call: ${input}`);
  });
  global.fetch = fetchMock;
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  service = require('./lnbitsService');
});

const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

afterEach(() => {
  global.fetch = originalFetch;
  restoreEnv('LNBITS_URL', originalUrl);
  restoreEnv('LNBITS_NODE_URL', originalNodeUrl);
  restoreEnv('LNBITS_API_TOKEN', originalToken);
  fetchMock.mockReset();
  jest.resetModules();
});

describe('least privilege', () => {
  // The bot never logs in to LNbits (mandatory 2FA would refuse it) and
  // never calls the admin Users API; checked against the source itself.
  test('no bot source calls /api/v1/auth or /users/api/v1, or reads the old credentials', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          const code = fs
            .readFileSync(full, 'utf8')
            .split('\n')
            .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join('\n');
          if (
            /\/api\/v1\/auth\b|\/users\/api\/v1|LNBITS_(USERNAME|PASSWORD|ADMINKEY)\b/.test(
              code,
            )
          ) {
            offenders.push(path.relative(process.cwd(), full));
          }
        }
      }
    };
    walk(path.resolve(__dirname, '..'));
    expect(offenders).toEqual([]);
  });

  test('LNBITS_NODE_URL is still read when LNBITS_URL is unset', async () => {
    delete process.env.LNBITS_URL;
    process.env.LNBITS_NODE_URL = 'https://legacy.test/';
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ balance: 1000 }),
    );

    await service.getWalletBalance('in-key');

    expect(lastRequest().url).toBe('https://legacy.test/api/v1/wallet');
  });
});

describe('createInvoice', () => {
  test('POSTs an incoming payment with the invoice key and returns payment_request', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ payment_request: 'lnbc1invoice' }),
    );

    const result = await service.createInvoice(
      'in-key',
      'wallet-1',
      21,
      'memo text',
      {
        tag: 'zap',
      },
    );

    expect(result).toBe('lnbc1invoice');
    expect(lastRequest()).toEqual({
      url: `${BASE}/api/v1/payments`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': 'in-key',
        },
        body: JSON.stringify({
          out: false,
          amount: 21,
          memo: 'memo text',
          extra: { tag: 'zap' },
        }),
      },
    });
  });

  // createInvoice re-throws on a non-2xx response so callers can handle failures.
  test('rejects on a non-2xx response', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({}, { status: 500 }),
    );

    await expect(
      service.createInvoice('in-key', 'wallet-1', 21, 'memo', {}),
    ).rejects.toThrow('Error creating an invoice (status: 500)');
  });
});

describe('getWalletIdFromKey', () => {
  // GET /api/v1/wallets does not take a wallet key, so the id comes from the
  // key's own wallet. LNbits sends it to an admin key only.
  test('reads the id from GET /api/v1/wallet with the key', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ id: 'w-1', name: 'Allowance', balance: 0 }),
    );

    await expect(service.getWalletIdFromKey('admin-key')).resolves.toBe('w-1');
    expect(lastRequest()).toEqual({
      url: `${BASE}/api/v1/wallet`,
      init: {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': 'admin-key',
        },
      },
    });
  });

  test('is null, not a guess, when LNbits sends no id', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ name: 'Allowance', balance: 0 }),
    );

    await expect(service.getWalletIdFromKey('in-key')).resolves.toBeNull();
  });
});

describe('getPaymentsSince', () => {
  test('refuses to query payments when no wallet resolves for the key', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({}));

    await expect(service.getPaymentsSince('in-key', 0)).rejects.toThrow(
      'getPaymentsSince: no wallet could be resolved for the supplied key',
    );
    expect(
      fetchMock.mock.calls.some(call =>
        String(call[0]).includes('wallet=null'),
      ),
    ).toBe(false);
  });
});

// These read helpers used to `return error`, so a failed call resolved with an
// Error object that callers spent as a balance or pasted into a query string.
describe('read helpers rethrow instead of resolving with the Error', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['getWalletBalance', () => service.getWalletBalance('in-key')],
    ['getPaymentsSince', () => service.getPaymentsSince('in-key', 0)],
  ];

  test.each(cases)('%s rejects on a network error', async (_name, call) => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(call()).rejects.toThrow('fetch failed');
  });
});

describe('payInvoice', () => {
  test('POSTs an outgoing payment with the admin key and returns the payment data', async () => {
    const payment = { payment_hash: 'hash-1', checking_id: 'chk-1' };
    fetchMock.mockImplementationOnce(async () => jsonResponse(payment));

    const result = await service.payInvoice('admin-key', 'lnbc1invoice', {
      tag: 'zap',
    });

    expect(result).toEqual(payment);
    expect(lastRequest()).toEqual({
      url: `${BASE}/api/v1/payments`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': 'admin-key',
        },
        body: JSON.stringify({
          out: true,
          bolt11: 'lnbc1invoice',
          extra: { tag: 'zap' },
        }),
      },
    });
  });

  test('rejects on a non-2xx response', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({}, { status: 520 }),
    );

    await expect(
      service.payInvoice('admin-key', 'lnbc1invoice', {}),
    ).rejects.toThrow('Error paying invoice (status: 520)');
  });

  test('rejects on a network error', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(
      service.payInvoice('admin-key', 'lnbc1invoice', {}),
    ).rejects.toThrow('fetch failed');
  });
});

describe('payment reads', () => {
  test('sends a bounded timeout so a stalled LNbits cannot hang a turn', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse([]));

    await service.getPayments('ink-1', 1000, 0);

    const { url, init } = lastRequest();
    expect(url).toBe(`${BASE}/api/v1/payments?limit=1000&offset=0`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('rejects a malformed page instead of pasting it into the URL', async () => {
    // A bad page would come back as a short list, which reads exactly like
    // "no more payments" and silently truncates the history.
    await expect(service.getPayments('ink-1', 0)).rejects.toThrow(
      /Invalid payments page limit/,
    );
    await expect(service.getPayments('ink-1', 10.5)).rejects.toThrow(
      /Invalid payments page limit/,
    );
    await expect(service.getPayments('ink-1', Number.NaN)).rejects.toThrow(
      /Invalid payments page limit/,
    );
    await expect(service.getPayments('ink-1', 100, -1)).rejects.toThrow(
      /Invalid payments page offset/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('throws on an error status rather than reporting no payments', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ detail: 'slow down' }, { status: 429 }),
    );

    await expect(service.getPayments('ink-1')).rejects.toThrow(/429/);
  });

  test('getAllPaymentsPage reads the paginated endpoint with the ACL token', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse([{ id: 'p1' }]));

    const payments = await service.getAllPaymentsPage(1000, 2000);

    expect(payments).toEqual([{ id: 'p1' }]);
    const { url, init } = lastRequest();
    expect(url).toContain('/api/v1/payments/all/paginated?');
    expect(url).toContain('limit=1000');
    expect(url).toContain('offset=2000');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer acl-token',
    );
  });

  test('getAllPaymentsPage without the token signals unavailability without a request', async () => {
    delete process.env.LNBITS_API_TOKEN;

    await expect(service.getAllPaymentsPage(10, 0)).rejects.toBeInstanceOf(
      service.PaginatedPaymentsUnsupportedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('getAllPaymentsPage unwraps the shapes LNbits versions have shipped', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ data: [{ id: 'p1' }] }),
    );

    await expect(service.getAllPaymentsPage(10, 0)).resolves.toEqual([
      { id: 'p1' },
    ]);
  });

  test('getAllPaymentsPage signals unavailability so callers can fall back', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ detail: 'Not Found' }, { status: 404 }),
    );

    await expect(service.getAllPaymentsPage(10, 0)).rejects.toBeInstanceOf(
      service.PaginatedPaymentsUnsupportedError,
    );
  });

  test('getAllPaymentsPage still throws plainly on a server error', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ detail: 'boom' }, { status: 500 }),
    );

    const error = await service.getAllPaymentsPage(10, 0).catch(e => e);
    expect(error).not.toBeInstanceOf(service.PaginatedPaymentsUnsupportedError);
    expect(String(error)).toContain('500');
  });
});
