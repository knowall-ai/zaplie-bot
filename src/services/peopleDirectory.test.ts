import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import {
  ensurePerson,
  getBalances,
  getPerson,
  listPeople,
  listZaps,
  payReward,
  payZap,
  PaymentNotSentError,
  PaymentOutcomeUncertainError,
} from './peopleDirectory';

const OID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PEER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
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
  allowanceWalletId: 'nwc_ada',
  receive: { lightningAddress: null },
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

describe('least privilege', () => {
  // The bot holds no wallet credential: no LNbits login, no wallet key, no
  // NWC connection. Checked against the source itself.
  test('no bot source talks to LNbits or names a wallet credential', () => {
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
            /\/api\/v1\/(auth|wallets?|payments)\b|\/users\/api\/v1|X-Api-Key|nostr\+walletconnect|LNBITS_(USERNAME|PASSWORD|ADMINKEY|API_TOKEN)\b|TREASURY_(ADMINKEY|NWC)/.test(
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
});

describe('people', () => {
  test('ensurePerson posts the sender; the answer carries no credential', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ person: person(), awaitingOperator: false }),
    );

    const { user, awaitingOperator } = await ensurePerson({
      aadObjectId: OID,
      displayName: 'Ada',
    });

    const { url, init } = lastCall();
    expect(url).toBe(`${API}/directory/internal/people/ensure`);
    expect(init.headers.Authorization).toBe('internal-token');
    expect(JSON.parse(String(init.body))).toEqual({
      aadObjectId: OID,
      displayName: 'Ada',
    });
    expect(awaitingOperator).toBe(false);
    expect(user).toEqual({
      id: OID,
      displayName: 'Ada',
      profileImg: '',
      aadObjectId: OID,
      email: 'ada@example.test',
      allowanceWallet: { id: 'nwc_ada' },
      canReceive: false,
    });
  });

  test('someone awaiting an operator has no Allowance wallet; an address means they can receive', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        people: [
          person({ allowanceWalletId: null }),
          person({
            oid: PEER,
            receive: { lightningAddress: 'peer@bank.test' },
          }),
        ],
      }),
    );

    const people = await listPeople();

    expect(people.map(p => [p.allowanceWallet, p.canReceive])).toEqual([
      [null, false],
      [{ id: 'nwc_ada' }, true],
    ]);
  });

  test('getPerson is null for someone not in the directory, and ids stay in their segment', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'not found' }, 404));

    await expect(getPerson('../admin')).resolves.toBeNull();
    expect(lastCall().url).toBe(`${API}/directory/internal/people/..%2Fadmin`);
  });

  test('a malformed person fails loudly', async () => {
    fetchMock.mockResolvedValueOnce(json({ person: { oid: OID } }));

    await expect(getPerson(OID)).rejects.toThrow(/invalid person/);
  });
});

describe('payments', () => {
  const zapInput = {
    senderOid: OID,
    recipientOid: PEER,
    amountSats: 21,
    memo: 'thanks',
    idempotencyKey: 'k'.repeat(64),
  };

  test('payZap names both people by Entra id and returns the payment hash', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ paymentHash: 'ab'.repeat(32), outcome: 'paid' }),
    );

    await expect(payZap(zapInput)).resolves.toBe('ab'.repeat(32));
    const { url, init } = lastCall();
    expect(url).toBe(`${API}/directory/internal/zaps`);
    expect(JSON.parse(String(init.body))).toEqual(zapInput);
  });

  test('a not_paid answer is safe to retry; anything else is uncertain', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        { error: 'Insufficient allowance balance', outcome: 'not_paid' },
        409,
      ),
    );
    const refused = await payZap(zapInput).catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(PaymentNotSentError);
    expect((refused as Error).message).toBe('Insufficient allowance balance');

    fetchMock.mockResolvedValueOnce(
      json(
        { error: 'the payment could not be completed', outcome: 'unknown' },
        503,
      ),
    );
    await expect(payZap(zapInput)).rejects.toBeInstanceOf(
      PaymentOutcomeUncertainError,
    );

    fetchMock.mockResolvedValueOnce(json({ error: 'bad gateway' }, 502));
    await expect(payZap(zapInput)).rejects.toBeInstanceOf(
      PaymentOutcomeUncertainError,
    );

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(payZap(zapInput)).rejects.toBeInstanceOf(
      PaymentOutcomeUncertainError,
    );
  });

  test('payReward posts the reward details to the rewards route', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ paymentHash: 'cd'.repeat(32), outcome: 'paid' }),
    );

    await payReward({
      recipientOid: PEER,
      recipientLabel: 'octocat',
      amountSats: 50,
      memo: 'GitHub: PR #7 merged',
      reward: { eventType: 'githubPrMerged', baseSats: 50 },
      idempotencyKey: 'r'.repeat(64),
    });

    expect(lastCall().url).toBe(`${API}/directory/internal/rewards`);
  });
});

describe('reads', () => {
  test('getBalances keeps an unreadable wallet as null and derives the remaining budget', async () => {
    fetchMock.mockResolvedValueOnce(json({ allowanceSats: 21, budget: null }));
    await expect(getBalances(OID)).resolves.toEqual({
      allowanceSats: 21,
      budgetRemainingSats: null,
    });

    fetchMock.mockResolvedValueOnce(
      json({ allowanceSats: null, budget: { totalSats: 100, usedSats: 30 } }),
    );
    await expect(getBalances(OID)).resolves.toEqual({
      allowanceSats: null,
      budgetRemainingSats: 70,
    });
  });

  test('listZaps passes the window and drops malformed records', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        zaps: [
          {
            paymentHash: 'ab'.repeat(32),
            kind: 'zap',
            time: 10,
            amountSats: 3,
            memo: '',
            from: { oid: OID, displayName: 'Ada' },
            to: { oid: PEER, displayName: 'Bea' },
          },
          { paymentHash: 'broken' },
        ],
      }),
    );

    const zaps = await listZaps(1700000000.9);

    expect(lastCall().url).toBe(
      `${API}/directory/internal/zaps?since=1700000000`,
    );
    expect(zaps).toHaveLength(1);
  });

  test('an error status from the portal is an error, not an empty answer', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'down' }, 502));

    await expect(listPeople()).rejects.toThrow(/status: 502/);
  });
});
