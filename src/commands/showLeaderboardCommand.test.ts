// showLeaderboardCommand.test.ts
//
// Mocks lnbitsService (the HTTP boundary), not the command and not
// zapHistoryService, so the wallet-semantics rules (Allowance debit matched to
// a Private credit, sweeps excluded) are exercised end to end — and so the
// assistant's get_leaderboard tool, which shares getZapLeaderboard, can be run
// against the very same fixtures to prove the two agree.

import {
  DEFAULT_LEADERBOARD_WINDOW_DAYS,
  LEADERBOARD_PARTIAL_MESSAGE,
  LEADERBOARD_UNAVAILABLE_MESSAGE,
  MAX_LEADERBOARD_TOP_N,
  MAX_LEADERBOARD_WINDOW_DAYS,
  ShowLeaderboardCommand,
  buildLeaderboardCard,
  leaderboardEmptyMessage,
  leaderboardTitle,
  leaderboardWindowLabel,
  windowStartSeconds,
} from './showLeaderboardCommand';
import { createReadOnlyTools } from './agentTools';
import { formatNumber } from '../i18n';
import {
  getAllPaymentsPage,
  getPayments,
  getUserWallets,
  getUsers,
  getWallets,
  PaginatedPaymentsUnsupportedError,
} from '../services/lnbitsService';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { TurnContext } from 'botbuilder';

jest.mock('../services/lnbitsService');

const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;
const mockGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;
const mockGetPayments = getPayments as jest.MockedFunction<typeof getPayments>;
const mockGetWallets = getWallets as jest.MockedFunction<typeof getWallets>;
const mockGetAllPaymentsPage = getAllPaymentsPage as jest.MockedFunction<
  typeof getAllPaymentsPage
>;

const NOW_SECONDS = 1_760_000_000;
const DAY = 86_400;

const person = (id: string, displayName: string): User => ({
  id,
  displayName,
  profileImg: '',
  aadObjectId: `aad-${id}`,
  email: `${id}@example.test`,
  privateWallet: null,
  allowanceWallet: null,
});

const walletFor = (owner: User, name: 'Allowance' | 'Private'): Wallet => ({
  id: `w-${owner.id}-${name.toLowerCase()}`,
  admin: '',
  name,
  user: owner.id,
  adminkey: `adm-${owner.id}-${name.toLowerCase()}`,
  inkey: `ink-${owner.id}-${name.toLowerCase()}`,
  balance_msat: 0,
  deleted: false,
});

const alice = person('alice', 'Alice');
const bob = person('bob', 'Bob');
const carol = person('carol', 'Carol');
const people = [alice, bob, carol];
const wallets = new Map(
  people.map(p => [
    p.id,
    { allowance: walletFor(p, 'Allowance'), priv: walletFor(p, 'Private') },
  ]),
);

const paymentsByInkey: Record<string, Transaction[]> = {};

// What the instance-wide paginated endpoint returns: the union of the
// per-wallet fixtures, each row once. That endpoint is the path production
// takes, so it is the one these tests drive by default.
const allFixturePayments = (): Transaction[] =>
  Object.values(paymentsByInkey).reduce<Transaction[]>(
    (rows, walletRows) => rows.concat(walletRows),
    [],
  );

const tx = (overrides: Partial<Transaction>): Transaction => ({
  checking_id: 'default',
  pending: false,
  amount: 0,
  fee: 0,
  memo: '',
  time: NOW_SECONDS,
  extra: {},
  wallet_id: '',
  ...overrides,
});

// One internal zap: a debit on the sender's Allowance wallet and the matching
// credit on the receiver's Private wallet, sharing a checking_id.
const zap = (
  id: string,
  from: User,
  to: User,
  sats: number,
  time: number = NOW_SECONDS,
  memo = 'Nice!',
) => {
  const fromWallet = wallets.get(from.id)!.allowance;
  const toWallet = wallets.get(to.id)!.priv;
  (paymentsByInkey[fromWallet.inkey] ??= []).push(
    tx({
      checking_id: id,
      amount: -sats * 1000,
      memo,
      time,
      wallet_id: fromWallet.id,
    }),
  );
  (paymentsByInkey[toWallet.inkey] ??= []).push(
    tx({
      checking_id: `internal_${id}`,
      amount: sats * 1000,
      memo,
      time,
      wallet_id: toWallet.id,
    }),
  );
};

const makeContext = () => {
  const sendActivity = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const context = { sendActivity } as unknown as TurnContext;
  return { context, sendActivity };
};

// The card is a plain Adaptive Card JSON object, so the assertions below read
// it structurally rather than through an `any`.
type CardElement = {
  type?: string;
  text?: string;
  width?: string;
  weight?: string;
  columns?: CardElement[];
  items?: CardElement[];
};

type Card = {
  body: CardElement[];
  actions?: { type: string; title: string; url: string }[];
};

const sentCard = (sendActivity: jest.Mock): Card => {
  const [activity] = sendActivity.mock.calls[0] as [
    { attachments: { content: Card }[] },
  ];
  return activity.attachments[0].content;
};

const rowText = (row: CardElement): string =>
  (row.columns ?? [])
    .map(column => (column.items ?? []).map(item => item.text).join(' '))
    .join(' | ');

const rows = (sendActivity: jest.Mock): string[] =>
  sentCard(sendActivity).body.slice(1).map(rowText);

describe('leaderboard copy', () => {
  test('says "last day" for a one-day window, not "last 1 days"', () => {
    expect(leaderboardWindowLabel(1)).toBe('last day');
    expect(leaderboardTitle(1, 'Sats')).toBe(
      'Top zappers (Sats sent, last day):',
    );
    expect(leaderboardEmptyMessage(1)).toBe(
      'No zaps sent in the last day yet. Send a zap to get things started!',
    );
  });

  test('keeps the plural for longer windows', () => {
    expect(leaderboardWindowLabel(7)).toBe('last 7 days');
    expect(leaderboardTitle(30, 'Sats')).toBe(
      'Top zappers (Sats sent, last 30 days):',
    );
  });

  test('says "último día" and "últimos N días" to a Spanish client', () => {
    expect(leaderboardWindowLabel(1, 'es-MX')).toBe('último día');
    expect(leaderboardWindowLabel(7, 'es-ES')).toBe('últimos 7 días');
    expect(leaderboardTitle(1, 'Sats', 'es-MX')).toBe(
      'Quienes más zapean (Sats enviados, último día):',
    );
    expect(leaderboardTitle(30, 'Sats', 'es-419')).toBe(
      'Quienes más zapean (Sats enviados, últimos 30 días):',
    );
    expect(leaderboardEmptyMessage(1, 'es')).toBe(
      'Todavía no se ha enviado ningún zap en el último día. ¡Envía un zap para empezar!',
    );
    expect(leaderboardEmptyMessage(365, 'es-ES')).toBe(
      'Todavía no se ha enviado ningún zap en los últimos 365 días. ¡Envía un zap para empezar!',
    );
  });

  test('keeps English for any other client language', () => {
    expect(leaderboardTitle(7, 'Sats', 'de-DE')).toBe(
      'Top zappers (Sats sent, last 7 days):',
    );
    expect(leaderboardEmptyMessage(7, undefined)).toBe(
      'No zaps sent in the last 7 days yet. Send a zap to get things started!',
    );
  });
});

describe('windowStartSeconds', () => {
  test('stays a real, positive cut-off at the longest accepted window', () => {
    // A negative cut-off is truthy, so getZapLeaderboard would apply it and
    // count every zap ever made while the card still named the window. The
    // ceiling keeps the cut-off positive for any clock after early 1971.
    const early1971 = Date.UTC(1971, 0, 2);
    expect(MAX_LEADERBOARD_WINDOW_DAYS).toBe(365);
    expect(
      windowStartSeconds(MAX_LEADERBOARD_WINDOW_DAYS, early1971),
    ).toBeGreaterThan(0);
    expect(
      windowStartSeconds(MAX_LEADERBOARD_WINDOW_DAYS, NOW_SECONDS * 1000),
    ).toBe(NOW_SECONDS - MAX_LEADERBOARD_WINDOW_DAYS * DAY);
  });
});

describe('buildLeaderboardCard', () => {
  const options = { title: 'Top zappers:', emptyMessage: 'Nothing yet.' };
  const entries = [
    { displayName: 'Alice', amount: 300 },
    { displayName: 'Bob', amount: 200 },
  ];

  test('starts with the given title and ranks each leader in a two-column row', () => {
    const card = buildLeaderboardCard(entries, 'Sats', options);

    expect(card.body[0]).toMatchObject({
      type: 'TextBlock',
      text: 'Top zappers:',
    });
    const cardRows = card.body.slice(1) as CardElement[];
    expect(cardRows.map(rowText)).toEqual([
      '#1 Alice | 300 Sats',
      '#2 Bob | 200 Sats',
    ]);
    // Name stretches on the left, bold amount sits on the right.
    const [nameColumn, amountColumn] = cardRows[0].columns ?? [];
    expect(nameColumn.width).toBe('stretch');
    expect(amountColumn.width).toBe('auto');
    expect((amountColumn.items ?? [])[0].weight).toBe('Bolder');
  });

  test('groups large amounts for readability', () => {
    const card = buildLeaderboardCard(
      [{ displayName: 'Alice', amount: 12345 }],
      'Sats',
      options,
    );

    expect(rowText(card.body[1])).toBe('#1 Alice | 12,345 Sats');
  });

  test('shows the empty message instead of a bare title', () => {
    const card = buildLeaderboardCard([], 'Sats', options);

    expect(card.body).toHaveLength(2);
    expect(card.body[1]).toMatchObject({
      type: 'TextBlock',
      text: 'Nothing yet.',
    });
  });

  test('adds the incomplete-read note only when the read was partial', () => {
    const complete = buildLeaderboardCard(entries, 'Sats', options);
    const partial = buildLeaderboardCard(entries, 'Sats', {
      ...options,
      partial: true,
    });

    expect(JSON.stringify(complete)).not.toContain(LEADERBOARD_PARTIAL_MESSAGE);
    expect(partial.body[partial.body.length - 1]).toMatchObject({
      type: 'TextBlock',
      text: LEADERBOARD_PARTIAL_MESSAGE,
    });
  });

  test('links the View Wallets button to the portal without a trailing slash', () => {
    const withButton = buildLeaderboardCard(entries, 'Sats', {
      ...options,
      portalUrl: 'https://portal.example.test/',
    });
    const withoutButton = buildLeaderboardCard(entries, 'Sats', options);

    expect(withButton.actions).toEqual([
      {
        type: 'Action.OpenUrl',
        title: 'View Wallets',
        url: 'https://portal.example.test/wallet',
      },
    ]);
    expect(withoutButton.actions).toBeUndefined();
  });

  test('writes its own copy and the amounts for a Spanish client', () => {
    const card = buildLeaderboardCard(
      [{ displayName: 'Alice', amount: 12345 }],
      'Sats',
      {
        ...options,
        partial: true,
        portalUrl: 'https://portal.example.test',
        locale: 'es-ES',
      },
    );

    expect(rowText(card.body[1])).toBe('#1 Alice | 12.345 Sats');
    expect(card.body[card.body.length - 1]).toMatchObject({
      text: 'No se pudieron leer algunas carteras en este momento, así que esta clasificación puede estar incompleta.',
    });
    expect(card.actions?.[0].title).toBe('Ver carteras');
    expect(JSON.stringify(card)).not.toContain(LEADERBOARD_PARTIAL_MESSAGE);
  });
});

describe('showLeaderboardCommand', () => {
  const originalEnv = { ...process.env };
  let nowSpy: jest.SpiedFunction<typeof Date.now>;

  beforeEach(() => {
    process.env.LNBITS_POINTS_LABEL = 'Sats';
    delete process.env.PORTAL_URL;
    delete process.env.LEADERBOARD_WINDOW_DAYS;
    delete process.env.LEADERBOARD_TOP_N;
    for (const key of Object.keys(paymentsByInkey)) {
      delete paymentsByInkey[key];
    }
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000);
    mockGetUsers.mockResolvedValue(people);
    mockGetUserWallets.mockImplementation(async (_adminKey, userId) => {
      const owned = wallets.get(userId);
      return owned ? [owned.allowance, owned.priv] : [];
    });
    mockGetPayments.mockImplementation(
      async (inKey: string) => (paymentsByInkey[inKey] || []) as Transaction[],
    );
    mockGetAllPaymentsPage.mockImplementation(async (limit, offset) =>
      allFixturePayments().slice(offset, offset + limit),
    );
  });

  afterEach(() => {
    nowSpy.mockRestore();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test('ranks by sats zapped out of Allowance wallets, never by Private balance', async () => {
    // Alice holds a large Private balance but sent nothing; Bob sent 300.
    // The old command read Private balances through getWallets, so that
    // boundary is stubbed too: on main this test fails on the ranking itself.
    const alicePrivate = wallets.get(alice.id)!.priv;
    alicePrivate.balance_msat = 9_000_000;
    mockGetWallets.mockResolvedValue([alicePrivate]);
    zap('z1', bob, alice, 300);
    const { context, sendActivity } = makeContext();

    try {
      await new ShowLeaderboardCommand().execute(context);

      expect(rows(sendActivity)).toEqual(['#1 Bob | 300 Sats']);
      const serialised = JSON.stringify(sentCard(sendActivity));
      expect(serialised).not.toContain('9,000');
      expect(serialised).not.toMatch(/balance/i);
      expect(mockGetWallets).not.toHaveBeenCalled();
    } finally {
      alicePrivate.balance_msat = 0;
    }
  });

  test('sums several zaps per sender and orders ties by name', async () => {
    zap('z1', alice, bob, 100);
    zap('z2', alice, carol, 50);
    zap('z3', carol, bob, 150);
    zap('z4', bob, alice, 150);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(rows(sendActivity)).toEqual([
      '#1 Alice | 150 Sats',
      '#2 Bob | 150 Sats',
      '#3 Carol | 150 Sats',
    ]);
  });

  test('excludes weekly allowance sweeps', async () => {
    zap(
      'sweep',
      alice,
      bob,
      5000,
      NOW_SECONDS,
      'Alice Weekly Allowance cleared',
    );
    zap('z1', bob, alice, 20);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(rows(sendActivity)).toEqual(['#1 Bob | 20 Sats']);
  });

  test('excludes credits that did not come from an Allowance wallet', async () => {
    // An external deposit into Carol's Private wallet has no Allowance debit.
    const carolPrivate = wallets.get(carol.id)!.priv;
    paymentsByInkey[carolPrivate.inkey] = [
      tx({
        checking_id: 'deposit',
        amount: 800_000,
        wallet_id: carolPrivate.id,
      }),
    ];
    zap('z1', alice, bob, 10);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(rows(sendActivity)).toEqual(['#1 Alice | 10 Sats']);
  });

  test('counts only zaps inside the configured window', async () => {
    process.env.LEADERBOARD_WINDOW_DAYS = '30';
    zap('old', alice, bob, 500, NOW_SECONDS - 40 * DAY);
    zap('edge', bob, alice, 40, NOW_SECONDS - 30 * DAY);
    zap('new', carol, alice, 30, NOW_SECONDS - 29 * DAY);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(rows(sendActivity)).toEqual([
      '#1 Bob | 40 Sats',
      '#2 Carol | 30 Sats',
    ]);
    expect(sentCard(sendActivity).body[0].text).toBe(
      'Top zappers (Sats sent, last 30 days):',
    );
  });

  test('rejects a zero window instead of ranking an unbounded history', async () => {
    // The window has no "all time" value: an unbounded read of a team's whole
    // history is the slowest read the bot can make, so 0 fails closed rather
    // than meaning "everything".
    process.env.LEADERBOARD_WINDOW_DAYS = '0';
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(sendActivity).toHaveBeenCalledWith(LEADERBOARD_UNAVAILABLE_MESSAGE);
    expect(mockGetUsers).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test('totals more zaps than the feed default limit of 50', async () => {
    // getRecentZaps defaults to the newest 50 for the feed; the leaderboard
    // must ask for everything in the window.
    for (let i = 0; i < 60; i++) {
      zap(`z${i}`, alice, bob, 1, NOW_SECONDS - i);
    }
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(rows(sendActivity)).toEqual(['#1 Alice | 60 Sats']);
  });

  test('counts a wallet named "allowance" in lower case and an ISO timestamp', async () => {
    wallets.get(carol.id)!.allowance.name = 'allowance';
    const carolAllowance = wallets.get(carol.id)!.allowance;
    const bobPrivate = wallets.get(bob.id)!.priv;
    (paymentsByInkey[carolAllowance.inkey] ??= []).push(
      tx({
        checking_id: 'iso',
        amount: -25_000,
        time: new Date(NOW_SECONDS * 1000).toISOString() as unknown as number,
        wallet_id: carolAllowance.id,
      }),
    );
    (paymentsByInkey[bobPrivate.inkey] ??= []).push(
      tx({
        checking_id: 'internal_iso',
        amount: 25_000,
        time: new Date(NOW_SECONDS * 1000).toISOString() as unknown as number,
        wallet_id: bobPrivate.id,
      }),
    );
    const { context, sendActivity } = makeContext();

    try {
      await new ShowLeaderboardCommand().execute(context);

      expect(rows(sendActivity)).toEqual(['#1 Carol | 25 Sats']);
    } finally {
      wallets.get(carol.id)!.allowance.name = 'Allowance';
    }
  });

  test('does not count a zap from a person to their own Private wallet', async () => {
    zap('self', alice, alice, 900);
    zap('z1', bob, alice, 20);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(rows(sendActivity)).toEqual(['#1 Bob | 20 Sats']);
  });

  test('caps the card at LEADERBOARD_TOP_N', async () => {
    process.env.LEADERBOARD_TOP_N = '2';
    zap('z1', alice, bob, 300);
    zap('z2', bob, carol, 200);
    zap('z3', carol, alice, 100);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(rows(sendActivity)).toEqual([
      '#1 Alice | 300 Sats',
      '#2 Bob | 200 Sats',
    ]);
  });

  test('shows a window-aware empty message when nobody has zapped', async () => {
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(sentCard(sendActivity).body[1]).toMatchObject({
      text: leaderboardEmptyMessage(DEFAULT_LEADERBOARD_WINDOW_DAYS),
    });
    expect(sentCard(sendActivity).body[1].text).toContain(
      `last ${DEFAULT_LEADERBOARD_WINDOW_DAYS} days`,
    );
  });

  test('links the View Wallets button to the configured portal', async () => {
    process.env.PORTAL_URL = 'https://portal.example.test/';
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(sentCard(sendActivity).actions[0].url).toBe(
      'https://portal.example.test/wallet',
    );
  });

  test('fails closed on an invalid setting and logs the variable name', async () => {
    process.env.LEADERBOARD_TOP_N = 'abc';
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    zap('z1', alice, bob, 10);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(sendActivity).toHaveBeenCalledWith(LEADERBOARD_UNAVAILABLE_MESSAGE);
    expect(consoleError).toHaveBeenCalledWith(
      'Error showing leaderboard:',
      expect.objectContaining({
        message: expect.stringContaining('LEADERBOARD_TOP_N'),
      }),
    );
    expect(mockGetUsers).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Above the ceiling the setting fails closed exactly like a malformed value.
  // Before the ceiling, a huge window produced a negative cut-off, every zap
  // ever made was counted, and the card still said "last 100000 days".
  test.each([
    ['LEADERBOARD_WINDOW_DAYS', '366'],
    ['LEADERBOARD_WINDOW_DAYS', '100000'],
    ['LEADERBOARD_TOP_N', '101'],
  ])(
    'fails closed when %s=%s is above its ceiling and logs the variable name',
    async (name, value) => {
      process.env[name] = value;
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      zap('z1', alice, bob, 10);
      const { context, sendActivity } = makeContext();

      try {
        await new ShowLeaderboardCommand().execute(context);

        expect(sendActivity).toHaveBeenCalledTimes(1);
        expect(sendActivity).toHaveBeenCalledWith(
          LEADERBOARD_UNAVAILABLE_MESSAGE,
        );
        expect(consoleError).toHaveBeenCalledWith(
          'Error showing leaderboard:',
          expect.objectContaining({
            message: expect.stringContaining(name),
          }),
        );
        expect(mockGetUsers).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  test('accepts both settings at their ceilings', async () => {
    process.env.LEADERBOARD_WINDOW_DAYS = String(MAX_LEADERBOARD_WINDOW_DAYS);
    process.env.LEADERBOARD_TOP_N = String(MAX_LEADERBOARD_TOP_N);
    zap('z1', alice, bob, 10, NOW_SECONDS - 364 * DAY);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(sentCard(sendActivity).body[0].text).toBe(
      'Top zappers (Sats sent, last 365 days):',
    );
    expect(rows(sendActivity)).toEqual(['#1 Alice | 10 Sats']);
  });

  test('says so on the card when some wallets could not be read', async () => {
    // A rate-limited wallet makes the totals a floor, not a total. Stating an
    // incomplete ranking as the ranking is the failure this note exists for.
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const consoleWarn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    mockGetAllPaymentsPage.mockRejectedValue(
      new PaginatedPaymentsUnsupportedError(404),
    );
    mockGetPayments.mockImplementation(async (inKey: string) => {
      if (inKey === wallets.get(carol.id)!.allowance.inkey) {
        throw new Error('429 Too Many Requests');
      }
      return (paymentsByInkey[inKey] || []) as Transaction[];
    });
    zap('z1', alice, bob, 10);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    const card = sentCard(sendActivity);
    expect(card.body[card.body.length - 1]).toMatchObject({
      text: LEADERBOARD_PARTIAL_MESSAGE,
    });
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });

  test('ranks the same on instances without the paginated payments endpoint', async () => {
    const consoleWarn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    mockGetAllPaymentsPage.mockRejectedValue(
      new PaginatedPaymentsUnsupportedError(404),
    );
    zap('z1', alice, bob, 100);
    zap('z2', carol, bob, 40);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(rows(sendActivity)).toEqual([
      '#1 Alice | 100 Sats',
      '#2 Carol | 40 Sats',
    ]);
    consoleWarn.mockRestore();
  });

  // The whole point of routing the command through getZapLeaderboard rather
  // than a second aggregator: the card and the assistant cannot disagree about
  // who is ahead for the same window over the same ledger.
  test('agrees with the assistant get_leaderboard tool on the same ledger', async () => {
    process.env.LEADERBOARD_WINDOW_DAYS = '30';
    zap('z1', alice, bob, 100);
    zap('z2', alice, carol, 50);
    zap('z3', carol, bob, 150);
    zap('z4', bob, alice, 150);
    zap('self', bob, bob, 900);
    zap('old', carol, alice, 5000, NOW_SECONDS - 40 * DAY);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    const tool = createReadOnlyTools().find(
      candidate => candidate.name === 'get_leaderboard',
    )!;
    const result = (await tool.handler({ days: 30 }, context)) as {
      leaderboard: { displayName: string; zappedSats: number }[];
    };

    expect(rows(sendActivity)).toEqual(
      result.leaderboard.map(
        (entry, index) =>
          `#${index + 1} ${entry.displayName} | ${formatNumber(entry.zappedSats, 'en')} Sats`,
      ),
    );
    expect(result.leaderboard).toEqual([
      { displayName: 'Alice', zappedSats: 150 },
      { displayName: 'Bob', zappedSats: 150 },
      { displayName: 'Carol', zappedSats: 150 },
    ]);
  });

  // When the assistant is asked "who is top of the leaderboard" it usually
  // omits days. It must then measure the same window as the card, or the two
  // quote different numbers for the same question.
  test('agrees with get_leaderboard when the assistant omits days', async () => {
    process.env.LEADERBOARD_WINDOW_DAYS = '30';
    zap('z1', alice, bob, 100);
    zap('z2', carol, bob, 40);
    zap('old', carol, alice, 5000, NOW_SECONDS - 40 * DAY);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    const tool = createReadOnlyTools().find(
      candidate => candidate.name === 'get_leaderboard',
    )!;
    const result = (await tool.handler({}, context)) as {
      periodDays: number;
      leaderboard: { displayName: string; zappedSats: number }[];
    };

    expect(result.periodDays).toBe(30);
    expect(rows(sendActivity)).toEqual([
      '#1 Alice | 100 Sats',
      '#2 Carol | 40 Sats',
    ]);
    expect(rows(sendActivity)).toEqual(
      result.leaderboard.map(
        (entry, index) =>
          `#${index + 1} ${entry.displayName} | ${formatNumber(entry.zappedSats, 'en')} Sats`,
      ),
    );
  });

  test('tells the user when LNbits is unavailable', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mockGetUsers.mockRejectedValue(new Error('LNbits timeout'));
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    // Silence would leave the user staring at a command that did nothing.
    expect(sendActivity).toHaveBeenCalledWith(LEADERBOARD_UNAVAILABLE_MESSAGE);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // The manifest describes the command in Spanish, so the card it answers
  // with is Spanish too, with the numbers grouped the way the client's region
  // writes them.
  describe('in the user language', () => {
    const localizedContext = (locale: string) => {
      const { context, sendActivity } = makeContext();
      (context as unknown as { activity: unknown }).activity = { locale };
      return { context, sendActivity };
    };

    test('answers an es-ES client in Spanish with Spain-style grouping', async () => {
      process.env.PORTAL_URL = 'https://portal.example.test';
      zap('z1', alice, bob, 12_345);
      const { context, sendActivity } = localizedContext('es-ES');

      await new ShowLeaderboardCommand().execute(context);

      const card = sentCard(sendActivity);
      expect(card.body[0].text).toBe(
        'Quienes más zapean (Sats enviados, últimos 7 días):',
      );
      expect(rows(sendActivity)).toEqual(['#1 Alice | 12.345 Sats']);
      expect(card.actions?.[0].title).toBe('Ver carteras');
      expect(JSON.stringify(card)).not.toContain(leaderboardTitle(7, 'Sats'));
    });

    test('groups an es-MX amount with a comma, as Mexico writes it', async () => {
      zap('z1', alice, bob, 12_345);
      const { context, sendActivity } = localizedContext('es-MX');

      await new ShowLeaderboardCommand().execute(context);

      expect(rows(sendActivity)).toEqual(['#1 Alice | 12,345 Sats']);
    });

    test('says the board is empty in Spanish, singular for one day', async () => {
      process.env.LEADERBOARD_WINDOW_DAYS = '1';
      const { context, sendActivity } = localizedContext('es-419');

      await new ShowLeaderboardCommand().execute(context);

      const card = sentCard(sendActivity);
      expect(card.body[0].text).toBe(
        'Quienes más zapean (Sats enviados, último día):',
      );
      expect(card.body[1]).toMatchObject({
        text: 'Todavía no se ha enviado ningún zap en el último día. ¡Envía un zap para empezar!',
      });
    });

    test('reports an unavailable leaderboard in Spanish', async () => {
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      mockGetUsers.mockRejectedValue(new Error('LNbits timeout'));
      const { context, sendActivity } = localizedContext('es-ES');

      await new ShowLeaderboardCommand().execute(context);

      expect(sendActivity).toHaveBeenCalledWith(
        'Lo siento, no pude cargar la clasificación en este momento. Inténtalo de nuevo en un momento.',
      );
      consoleError.mockRestore();
    });
  });
});
