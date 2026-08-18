// showLeaderboardCommand.test.ts
//
// Mocks lnbitsService (external dependency), not the command itself.

import {
  LEADERBOARD_EMPTY_MESSAGE,
  LEADERBOARD_LIMIT,
  LEADERBOARD_TITLE,
  LEADERBOARD_UNAVAILABLE_MESSAGE,
  ShowLeaderboardCommand,
  buildLeaderboardCard,
} from './showLeaderboardCommand';
import { getWallets, getUsers } from '../services/lnbitsService';
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

const mockGetWallets = getWallets as jest.MockedFunction<typeof getWallets>;
const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;

const wallet = (overrides: Partial<Wallet>): Wallet => ({
  id: 'w1',
  admin: 'admin',
  name: 'Private',
  user: 'user-1',
  adminkey: 'adminkey',
  inkey: 'inkey',
  balance_msat: 1_000_000,
  deleted: false,
  ...overrides,
});

const user = (overrides: Partial<User>): User => ({
  id: 'user-1',
  displayName: 'Alice',
  profileImg: '',
  aadObjectId: 'aad-alice',
  email: 'alice@example.com',
  privateWallet: null,
  allowanceWallet: null,
  ...overrides,
});

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

describe('buildLeaderboardCard', () => {
  const entries = [
    { displayName: 'Alice', amount: 300 },
    { displayName: 'Bob', amount: 200 },
    { displayName: 'Carol', amount: 100 },
  ];

  test('starts with the title and ranks each leader in a two-column row', () => {
    const card = buildLeaderboardCard(entries, 'Sats');

    expect(card.body[0]).toMatchObject({
      type: 'TextBlock',
      text: LEADERBOARD_TITLE,
    });

    const rows = card.body.slice(1) as any[];
    expect(rows).toHaveLength(3);
    expect(rowText(rows[0])).toBe('#1 Alice | 300 Sats');
    expect(rowText(rows[1])).toBe('#2 Bob | 200 Sats');
    expect(rowText(rows[2])).toBe('#3 Carol | 100 Sats');
    // The title names the balance rather than promising "zaps received".
    expect(LEADERBOARD_TITLE).toContain('balance');

    // Name stretches on the left, bold amount sits on the right.
    expect(rows[0].columns[0].width).toBe('stretch');
    expect(rows[0].columns[1].width).toBe('auto');
    expect(rows[0].columns[1].items[0].weight).toBe('Bolder');
  });

  test('caps the leaderboard at the top 10', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      displayName: `User ${i + 1}`,
      amount: 1500 - i * 100,
    }));

    const card = buildLeaderboardCard(many, 'Sats');

    const rows = card.body.slice(1) as any[];
    expect(rows).toHaveLength(LEADERBOARD_LIMIT);
    expect(rowText(rows[9])).toContain('#10 User 10');
  });

  test('groups large amounts for readability', () => {
    const card = buildLeaderboardCard(
      [{ displayName: 'Alice', amount: 12345 }],
      'Sats',
    );

    const rows = card.body.slice(1) as any[];
    expect(rowText(rows[0])).toBe(
      `#1 Alice | ${(12345).toLocaleString()} Sats`,
    );
  });

  test('says the leaderboard is empty instead of showing a bare title', () => {
    const card = buildLeaderboardCard([], 'Sats');

    expect(card.body).toHaveLength(2);
    expect(card.body[1]).toMatchObject({
      type: 'TextBlock',
      text: LEADERBOARD_EMPTY_MESSAGE,
    });
  });
});

describe('showLeaderboardCommand', () => {
  const originalPointsLabel = process.env.LNBITS_POINTS_LABEL;
  const originalPortalUrl = process.env.PORTAL_URL;

  beforeEach(() => {
    process.env.LNBITS_POINTS_LABEL = 'Sats';
    mockGetWallets.mockResolvedValue([
      wallet({ id: 'w1', user: 'user-1', balance_msat: 1_000_000 }),
      wallet({ id: 'w2', user: 'user-2', balance_msat: 2_000_000 }),
    ]);
    mockGetUsers.mockResolvedValue([
      user({ id: 'user-1', displayName: 'Alice' }),
      user({ id: 'user-2', displayName: 'Bob' }),
    ]);
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (originalPointsLabel === undefined) {
      delete process.env.LNBITS_POINTS_LABEL;
    } else {
      process.env.LNBITS_POINTS_LABEL = originalPointsLabel;
    }
    if (originalPortalUrl === undefined) {
      delete process.env.PORTAL_URL;
    } else {
      process.env.PORTAL_URL = originalPortalUrl;
    }
  });

  test('links the View Wallets button to the configured portal', async () => {
    process.env.PORTAL_URL = 'https://portal.example.test';
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(sentCard(sendActivity).actions).toEqual([
      {
        type: 'Action.OpenUrl',
        title: 'View Wallets',
        url: 'https://portal.example.test/wallet',
      },
    ]);
  });

  test('drops a trailing slash from the configured portal URL', async () => {
    process.env.PORTAL_URL = 'https://portal.example.test/';
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(sentCard(sendActivity).actions[0].url).toBe(
      'https://portal.example.test/wallet',
    );
  });

  test('omits the button entirely when PORTAL_URL is not set', async () => {
    delete process.env.PORTAL_URL;
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(sentCard(sendActivity).actions).toBeUndefined();
  });

  test('sorts by balance and resolves names with a single getUsers call', async () => {
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    const card = sentCard(sendActivity);
    const rows = card.body.slice(1) as any[];
    expect(rowText(rows[0])).toBe(`#1 Bob | ${(2000).toLocaleString()} Sats`);
    expect(rowText(rows[1])).toBe(`#2 Alice | ${(1000).toLocaleString()} Sats`);
    expect(mockGetUsers).toHaveBeenCalledTimes(1);
  });

  test('orders equal balances by name so the card is stable', async () => {
    mockGetWallets.mockResolvedValue([
      wallet({ id: 'w1', user: 'user-1', balance_msat: 1_000_000 }),
      wallet({ id: 'w2', user: 'user-2', balance_msat: 1_000_000 }),
      wallet({ id: 'w3', user: 'user-3', balance_msat: 1_000_000 }),
    ]);
    mockGetUsers.mockResolvedValue([
      user({ id: 'user-1', displayName: 'Carol' }),
      user({ id: 'user-2', displayName: 'Alice' }),
      user({ id: 'user-3', displayName: 'Bob' }),
    ]);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    const rows = sentCard(sendActivity).body.slice(1) as any[];
    expect(rows.map((row: any) => rowText(row).split(' | ')[0])).toEqual([
      '#1 Alice',
      '#2 Bob',
      '#3 Carol',
    ]);
  });

  test('never ranks a wallet whose owner is missing from the directory', async () => {
    const consoleWarn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    mockGetWallets.mockResolvedValue([
      wallet({ id: 'w1', user: 'user-1', balance_msat: 1_000_000 }),
      wallet({ id: 'w-orphan', user: 'ghost-user', balance_msat: 9_000_000 }),
    ]);
    mockGetUsers.mockResolvedValue([
      user({ id: 'user-1', displayName: 'Alice' }),
    ]);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    const rows = sentCard(sendActivity).body.slice(1) as any[];
    expect(rows).toHaveLength(1);
    expect(rowText(rows[0])).toContain('#1 Alice');
    expect(JSON.stringify(sentCard(sendActivity))).not.toContain(
      'Unknown user',
    );
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('w-orphan'),
    );
    consoleWarn.mockRestore();
  });

  test('shows the empty-leaderboard card when no wallet can be ranked', async () => {
    mockGetWallets.mockResolvedValue([]);
    mockGetUsers.mockResolvedValue([]);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(sentCard(sendActivity).body[1]).toMatchObject({
      text: LEADERBOARD_EMPTY_MESSAGE,
    });
  });

  test('tells the user when the wallet directory is unavailable', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mockGetWallets.mockResolvedValue(null);
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    // Silence would leave the user staring at a command that did nothing.
    expect(sendActivity).toHaveBeenCalledWith(LEADERBOARD_UNAVAILABLE_MESSAGE);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
