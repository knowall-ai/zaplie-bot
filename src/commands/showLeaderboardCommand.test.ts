// showLeaderboardCommand.test.ts
//
// Mocks lnbitsService (the HTTP boundary), not the command and not
// zapHistoryService, so the wallet-semantics rules (Allowance debit matched to
// a Private credit, sweeps excluded) are exercised end to end.

import {
  LEADERBOARD_UNAVAILABLE_MESSAGE,
  ShowLeaderboardCommand,
  buildLeaderboardCard,
} from './showLeaderboardCommand';
import {
  getPayments,
  getUserWallets,
  getUsers,
  getWallets,
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

const sentCard = (sendActivity: jest.Mock): any => {
  const [activity] = sendActivity.mock.calls[0] as [any];
  return activity.attachments[0].content;
};

const rowText = (row: any): string =>
  row.columns
    .map((column: any) => column.items.map((item: any) => item.text).join(' '))
    .join(' | ');

const rows = (sendActivity: jest.Mock): string[] =>
  (sentCard(sendActivity).body.slice(1) as any[]).map(rowText);

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
    const cardRows = card.body.slice(1) as any[];
    expect(cardRows.map(rowText)).toEqual([
      '#1 Alice | 300 Sats',
      '#2 Bob | 200 Sats',
    ]);
    // Name stretches on the left, bold amount sits on the right.
    expect(cardRows[0].columns[0].width).toBe('stretch');
    expect(cardRows[0].columns[1].width).toBe('auto');
    expect(cardRows[0].columns[1].items[0].weight).toBe('Bolder');
  });

  test('groups large amounts for readability', () => {
    const card = buildLeaderboardCard(
      [{ displayName: 'Alice', amount: 12345 }],
      'Sats',
      options,
    );

    expect(rowText(card.body[1])).toBe(
      `#1 Alice | ${(12345).toLocaleString()} Sats`,
    );
  });

  test('shows the empty message instead of a bare title', () => {
    const card = buildLeaderboardCard([], 'Sats', options);

    expect(card.body).toHaveLength(2);
    expect(card.body[1]).toMatchObject({
      type: 'TextBlock',
      text: 'Nothing yet.',
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
    // LNbits returns at most 100 payments per wallet, so "all time" would
    // silently undercount; the setting fails closed until paging exists.
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
      text: 'No zaps sent in the last 7 days yet. Send a zap to get things started!',
    });
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
});
