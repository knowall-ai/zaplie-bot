import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import {
  createInvoiceForPerson,
  ensurePerson,
  getBalances,
  getPerson,
  listPeople,
  RecipientNotReadyError,
} from './peopleDirectory';

const OID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const API = 'https://portal.test/api';

const fetchMock = jest.fn<typeof fetch>();
const originalFetch = global.fetch;
const saved = {
  token: process.env.TAB_BACKEND_TOKEN,
  url: process.env.WEBSITE_API_URL,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const person = (overrides: Record<string, unknown> = {}) => ({
  oid: OID,
  displayName: 'Ada',
  email: 'ada@example.test',
  allowanceWalletId: 'w-ada',
  receive: { lightningAddress: null, invoiceKeyRegistered: false },
  ...overrides,
});

beforeEach(() => {
  process.env.TAB_BACKEND_TOKEN = 'internal-token';
  process.env.WEBSITE_API_URL = `${API}/`;
  fetchMock.mockReset();
  global.fetch = fetchMock;
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const [key, value] of [
    ['TAB_BACKEND_TOKEN', saved.token],
    ['WEBSITE_API_URL', saved.url],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return {
    url: String(url),
    init: init as RequestInit & { headers: Record<string, string> },
  };
};

describe('peopleDirectory', () => {
  test('ensurePerson posts the sender and maps their own Allowance keys', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        person: person({
          allowanceWallet: { id: 'w-ada', adminkey: 'ad', inkey: 'in' },
        }),
        awaitingOperator: false,
      }),
    );

    const { user, awaitingOperator } = await ensurePerson({
      aadObjectId: OID,
      displayName: 'Ada',
    });

    const { url, init } = lastCall();
    expect(url).toBe(`${API}/directory/internal/people/ensure`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('internal-token');
    expect(JSON.parse(String(init.body))).toEqual({
      aadObjectId: OID,
      displayName: 'Ada',
    });
    expect(awaitingOperator).toBe(false);
    expect(user).toMatchObject({
      id: OID,
      aadObjectId: OID,
      canReceive: false,
      allowanceWallet: {
        id: 'w-ada',
        name: 'Allowance',
        user: OID,
        adminkey: 'ad',
        inkey: 'in',
      },
    });
  });

  test('a person awaiting an operator has no Allowance wallet', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        person: person({ allowanceWalletId: null, allowanceWallet: null }),
        awaitingOperator: true,
      }),
    );

    const result = await ensurePerson({ aadObjectId: OID });

    expect(result.awaitingOperator).toBe(true);
    expect(result.user.allowanceWallet).toBeNull();
  });

  test('listPeople marks who can receive', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        people: [
          person({
            receive: {
              lightningAddress: 'ada@bank.test',
              invoiceKeyRegistered: false,
            },
            allowanceWallet: { id: 'w-ada', inkey: 'in' },
          }),
          person({ oid: 'other', displayName: 'Bob' }),
        ],
      }),
    );

    const people = await listPeople();

    expect(people.map(p => [p.id, p.canReceive])).toEqual([
      [OID, true],
      ['other', false],
    ]);
    expect(people[0].allowanceWallet?.adminkey).toBe('');
  });

  test('getPerson is null for someone not in the directory', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'not found' }, 404));

    await expect(getPerson('../admin')).resolves.toBeNull();
    expect(lastCall().url).toBe(`${API}/directory/internal/people/..%2Fadmin`);
  });

  test('a malformed person fails loudly', async () => {
    fetchMock.mockResolvedValueOnce(json({ person: { oid: OID } }));

    await expect(getPerson(OID)).rejects.toThrow(/invalid person/);
  });

  test('a recipient who cannot be invoiced yet is a RecipientNotReadyError', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: 'Ada has not set up where they receive zaps yet' }, 409),
    );

    const error = await createInvoiceForPerson(OID, 21, 'thanks', {}).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RecipientNotReadyError);
    expect((error as Error).message).toBe(
      'Ada has not set up where they receive zaps yet',
    );
  });

  test('createInvoiceForPerson returns the payment request', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ paymentRequest: 'lnbc210n1pinvoice', via: 'invoice-key' }, 201),
    );

    await expect(
      createInvoiceForPerson(OID, 21, 'thanks', { tag: 'zap' }),
    ).resolves.toBe('lnbc210n1pinvoice');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      amountSats: 21,
      memo: 'thanks',
      extra: { tag: 'zap' },
    });
  });

  test('a response with no payment request is refused', async () => {
    fetchMock.mockResolvedValueOnce(json({ paymentRequest: 'not-a-bolt11' }));

    await expect(createInvoiceForPerson(OID, 21, 'x', {})).rejects.toThrow(
      /no payment request/,
    );
  });

  test('getBalances keeps an unreadable wallet as null', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ allowanceSats: 21, privateSats: null }),
    );

    await expect(getBalances(OID)).resolves.toEqual({
      allowanceSats: 21,
      privateSats: null,
    });
  });

  test('an error status from the portal is an error, not an empty answer', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'down' }, 502));

    await expect(listPeople()).rejects.toThrow(/status: 502/);
  });
});
