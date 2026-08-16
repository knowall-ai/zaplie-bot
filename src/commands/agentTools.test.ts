// agentTools.test.ts
//
// Mocks lnbitsService/zapHistoryService/graphService (external dependencies),
// not agentTools itself. createZapCard runs for real so the propose_zap tests
// cover the card prefill end to end.

import { createAgentTools } from './agentTools';
import { MAX_ZAP_SATS } from './zapBudget';
import {
  getUserWallets,
  getUsers,
  getWalletBalance,
} from '../services/lnbitsService';
import {
  getZapActivity,
  getZapLeaderboard,
} from '../services/zapHistoryService';
import { getRecentMeetings, getRelevantPeople } from '../services/graphService';
import {
  afterEach,
  expect,
  describe,
  test,
  beforeEach,
  jest,
} from '@jest/globals';
import { Activity, TurnContext } from 'botbuilder';
import { isRecord } from '../utils/typeGuards';

// Tool results are `unknown` by contract. Narrowing once here keeps the
// assertions honest without an `any` in every test.
const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`Expected the tool to return an object, got ${value}.`);
  }
  return value;
};

jest.mock('../services/lnbitsService');
jest.mock('../services/zapHistoryService');
jest.mock('../services/graphService');

const mockGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;
const mockGetZapActivity = getZapActivity as jest.MockedFunction<
  typeof getZapActivity
>;

// getZapActivity reports both the zaps and how complete the read was; most
// tests only care about the zaps.
const activityResult = (
  zaps: ZapActivityForTest[],
  coverage: Partial<{
    partial: boolean;
    skippedUsers: number;
    skippedWallets: number;
    truncated: boolean;
  }> = {},
) => ({
  zaps,
  partial: false,
  skippedUsers: 0,
  skippedWallets: 0,
  truncated: false,
  ...coverage,
});

type ZapActivityForTest = Awaited<
  ReturnType<typeof getZapActivity>
>['zaps'][number];

const leaderboardResult = (
  entries: Awaited<ReturnType<typeof getZapLeaderboard>>['entries'],
  coverage: Partial<{
    partial: boolean;
    skippedUsers: number;
    skippedWallets: number;
    truncated: boolean;
  }> = {},
) => ({
  entries,
  partial: false,
  skippedUsers: 0,
  skippedWallets: 0,
  truncated: false,
  ...coverage,
});
const mockGetZapLeaderboard = getZapLeaderboard as jest.MockedFunction<
  typeof getZapLeaderboard
>;
const mockGetRecentMeetings = getRecentMeetings as jest.MockedFunction<
  typeof getRecentMeetings
>;
const mockGetRelevantPeople = getRelevantPeople as jest.MockedFunction<
  typeof getRelevantPeople
>;
const mockGetWalletBalance = getWalletBalance as jest.MockedFunction<
  typeof getWalletBalance
>;
const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;

const currentUser: User = {
  id: 'user-1',
  displayName: 'Alice',
  profileImg: '',
  aadObjectId: 'aad-alice',
  email: 'alice@example.com',
  privateWallet: null,
  allowanceWallet: null,
};

const makeTurnContext = (user: User | undefined): TurnContext => {
  const turnState = new Map<string, unknown>();
  if (user) turnState.set('user', user);
  return {
    turnState,
    sendActivity: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as TurnContext;
};

// Only the fields the propose_zap prefill assertions read: the card is built
// by the real createZapCard, so this is a view of it, not a duplicate of it.
interface ZapCardForTest {
  body: { id?: string; value?: string }[];
}

const wallet = (overrides: Partial<Wallet>): Wallet => ({
  id: 'w1',
  admin: '',
  name: 'Allowance',
  user: 'user-1',
  adminkey: '',
  inkey: '',
  balance_msat: 0,
  deleted: false,
  ...overrides,
});

describe('agentTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('get_my_balance', () => {
    test('returns only Allowance and Private balances in sats', async () => {
      mockGetUserWallets.mockResolvedValue([
        wallet({ name: 'Allowance', balance_msat: 900000 }),
        wallet({ name: 'LNbits wallet', balance_msat: 3000000 }),
        wallet({ name: 'Private', balance_msat: 50000 }),
      ]);

      const tool = createAgentTools().find(t => t.name === 'get_my_balance')!;
      const result = requireRecord(
        await tool.handler({}, makeTurnContext(currentUser)),
      );

      expect(result.wallets).toEqual([
        { name: 'Allowance', balanceSats: 900 },
        { name: 'Private', balanceSats: 50 },
      ]);
    });

    test('matches wallet names case-insensitively, as LNbits echoes them back', async () => {
      mockGetUserWallets.mockResolvedValue([
        wallet({ name: 'allowance', balance_msat: 900000 }),
        wallet({ name: 'PRIVATE', balance_msat: 50000 }),
      ]);

      const tool = createAgentTools().find(t => t.name === 'get_my_balance')!;
      const result = requireRecord(
        await tool.handler({}, makeTurnContext(currentUser)),
      );

      expect(
        (result.wallets as Array<{ name: string }>).map(w => w.name),
      ).toEqual(['allowance', 'PRIVATE']);
    });

    test('rejects unknown arguments rather than ignoring them', async () => {
      const tool = createAgentTools().find(t => t.name === 'get_my_balance')!;

      const result = requireRecord(
        await tool.handler(
          { userId: 'someone-else' },
          makeTurnContext(currentUser),
        ),
      );

      expect(result.error).toContain('userId');
      expect(mockGetUserWallets).not.toHaveBeenCalled();
    });
  });

  test('every tool schema refuses properties it does not declare', () => {
    process.env.GRAPH_CONNECTION_NAME = 'GraphWorkSignals';
    try {
      for (const tool of createAgentTools()) {
        expect(tool.parameters).toMatchObject({ additionalProperties: false });
      }
    } finally {
      delete process.env.GRAPH_CONNECTION_NAME;
    }
  });

  describe('get_leaderboard', () => {
    test('reports sats zapped out of Allowance wallets, never wallet balances', async () => {
      mockGetZapLeaderboard.mockResolvedValue(
        leaderboardResult([
          {
            user: { ...currentUser, id: 'user-alice', displayName: 'Alice' },
            zappedSats: 1500,
          },
          {
            user: { ...currentUser, id: 'user-bob', displayName: 'Bob' },
            zappedSats: 500,
          },
        ]),
      );

      const tool = createAgentTools().find(t => t.name === 'get_leaderboard')!;
      const result = requireRecord(
        await tool.handler({}, makeTurnContext(currentUser)),
      );

      expect(result.leaderboard).toEqual([
        { displayName: 'Alice', zappedSats: 1500 },
        { displayName: 'Bob', zappedSats: 500 },
      ]);
      expect(result.partial).toBe(false);
      expect(result.incompleteReason).toBeUndefined();
      expect(mockGetUserWallets).not.toHaveBeenCalled();
    });

    test('accepts a days window and passes the cut-off through', async () => {
      mockGetZapLeaderboard.mockResolvedValue(leaderboardResult([]));
      const tool = createAgentTools().find(t => t.name === 'get_leaderboard')!;

      // The tool must advertise the parameter, or the model cannot answer
      // "who zapped most this week" with anything but all-time totals.
      expect(tool.parameters.properties).toHaveProperty('days');

      const before = Math.floor(Date.now() / 1000);
      const result = requireRecord(
        await tool.handler({ days: 7 }, makeTurnContext(currentUser)),
      );
      const after = Math.floor(Date.now() / 1000);

      const since = mockGetZapLeaderboard.mock.calls[0][0]!.sinceTimestamp!;
      expect(since).toBeGreaterThanOrEqual(before - 7 * 86400);
      expect(since).toBeLessThanOrEqual(after - 7 * 86400);
      expect(result.periodDays).toBe(7);
    });

    test('defaults to all-time when days is omitted', async () => {
      mockGetZapLeaderboard.mockResolvedValue(leaderboardResult([]));
      const tool = createAgentTools().find(t => t.name === 'get_leaderboard')!;

      const allTime = requireRecord(
        await tool.handler({}, makeTurnContext(currentUser)),
      );
      expect(mockGetZapLeaderboard).toHaveBeenLastCalledWith({
        sinceTimestamp: undefined,
      });
      expect(allTime.periodDays).toBeNull();
    });

    test('rejects an out-of-range or malformed days instead of clamping it', async () => {
      // The model composes these arguments and nothing validates them against
      // the schema before the handler runs. Clamping 400 to 365 would answer a
      // different question than the one asked while still reporting the asked-
      // for window — a wrong number, stated confidently.
      mockGetZapLeaderboard.mockResolvedValue(leaderboardResult([]));
      const tool = createAgentTools().find(t => t.name === 'get_leaderboard')!;

      for (const days of [0, -7, 400, 7.5, Number.NaN, '7' as never]) {
        const result = requireRecord(
          await tool.handler({ days }, makeTurnContext(currentUser)),
        );
        expect(result.error).toBeTruthy();
        expect(result.leaderboard).toBeUndefined();
      }
      expect(mockGetZapLeaderboard).not.toHaveBeenCalled();
    });

    test('rejects unknown arguments rather than ignoring them', async () => {
      mockGetZapLeaderboard.mockResolvedValue(leaderboardResult([]));
      const tool = createAgentTools().find(t => t.name === 'get_leaderboard')!;

      const result = requireRecord(
        await tool.handler({ weeks: 2 } as never, makeTurnContext(currentUser)),
      );

      expect(result.error).toContain('weeks');
      expect(mockGetZapLeaderboard).not.toHaveBeenCalled();
    });

    test('reports exactly the window it measured', async () => {
      mockGetZapLeaderboard.mockResolvedValue(leaderboardResult([]));
      const tool = createAgentTools().find(t => t.name === 'get_leaderboard')!;

      // Bracket the call rather than comparing against a later Date.now():
      // the clock can tick a second between the handler and the assertion.
      const before = Math.floor(Date.now() / 1000);
      const result = requireRecord(
        await tool.handler({ days: 365 }, makeTurnContext(currentUser)),
      );
      const after = Math.floor(Date.now() / 1000);

      const since = mockGetZapLeaderboard.mock.calls[0][0]!.sinceTimestamp!;
      expect(result.periodDays).toBe(365);
      expect(since).toBeGreaterThanOrEqual(before - 365 * 86400);
      expect(since).toBeLessThanOrEqual(after - 365 * 86400);
    });

    test('flags an incomplete read so the assistant can hedge', async () => {
      mockGetZapLeaderboard.mockResolvedValue(
        leaderboardResult(
          [
            {
              user: { ...currentUser, id: 'user-alice', displayName: 'Alice' },
              zappedSats: 1500,
            },
          ],
          { partial: true, skippedUsers: 1, skippedWallets: 2 },
        ),
      );

      const tool = createAgentTools().find(t => t.name === 'get_leaderboard')!;
      const result = requireRecord(
        await tool.handler({}, makeTurnContext(currentUser)),
      );

      expect(result.partial).toBe(true);
      expect(result.incompleteReason).toContain('incomplete');
      expect(result.incompleteReason).toContain('1 user(s)');
      expect(result.incompleteReason).toContain('2 wallet(s)');
    });
  });

  describe('get_recent_activity', () => {
    test('passes limit and onlyInvolvingMe through to getZapActivity', async () => {
      mockGetZapActivity.mockResolvedValue(
        activityResult([
          {
            from: { ...currentUser, displayName: 'Alice' },
            to: { ...currentUser, displayName: 'Bob' },
            amountSats: 100,
            memo: 'Great work!',
            time: new Date('2026-07-15T10:00:00Z'),
          },
        ]),
      );

      const tool = createAgentTools().find(
        t => t.name === 'get_recent_activity',
      )!;
      const result = requireRecord(
        await tool.handler(
          { limit: 10, onlyInvolvingMe: true },
          makeTurnContext(currentUser),
        ),
      );

      expect(mockGetZapActivity).toHaveBeenCalledWith({
        limit: 10,
        userAadObjectId: 'aad-alice',
      });
      expect(result.activity).toEqual([
        {
          from: 'Alice',
          to: 'Bob',
          amountSats: 100,
          memo: 'Great work!',
          time: '2026-07-15T10:00:00.000Z',
        },
      ]);
    });

    test('clamps limit to [1, 50] and defaults to 20', async () => {
      mockGetZapActivity.mockResolvedValue(activityResult([]));

      const tool = createAgentTools().find(
        t => t.name === 'get_recent_activity',
      )!;

      await tool.handler({ limit: 500 }, makeTurnContext(currentUser));
      expect(mockGetZapActivity).toHaveBeenLastCalledWith({
        limit: 50,
        userAadObjectId: undefined,
      });

      // A negative limit must not flow through to Array.prototype.slice,
      // where slice(0, -1) would return almost everything instead of a
      // small capped list.
      await tool.handler({ limit: -1 }, makeTurnContext(currentUser));
      expect(mockGetZapActivity).toHaveBeenLastCalledWith({
        limit: 1,
        userAadObjectId: undefined,
      });

      await tool.handler({}, makeTurnContext(currentUser));
      expect(mockGetZapActivity).toHaveBeenLastCalledWith({
        limit: 20,
        userAadObjectId: undefined,
      });
    });

    test('falls back to the default limit rather than passing NaN or a fraction through', async () => {
      mockGetZapActivity.mockResolvedValue(activityResult([]));
      const tool = createAgentTools().find(
        t => t.name === 'get_recent_activity',
      )!;

      // NaN survived Math.min/Math.max and reached the query; 10.5 reached
      // Array.prototype.slice.
      for (const limit of [Number.NaN, 10.5, Number.POSITIVE_INFINITY, '10']) {
        await tool.handler({ limit }, makeTurnContext(currentUser));
        expect(mockGetZapActivity).toHaveBeenLastCalledWith({
          limit: 20,
          userAadObjectId: undefined,
        });
      }
    });

    test('rejects unknown arguments rather than ignoring them', async () => {
      mockGetZapActivity.mockResolvedValue(activityResult([]));
      const tool = createAgentTools().find(
        t => t.name === 'get_recent_activity',
      )!;

      const result = requireRecord(
        await tool.handler({ count: 5 }, makeTurnContext(currentUser)),
      );

      expect(result.error).toContain('count');
      expect(mockGetZapActivity).not.toHaveBeenCalled();
    });

    test('rejects a non-boolean onlyInvolvingMe instead of reading it as false', async () => {
      mockGetZapActivity.mockResolvedValue(activityResult([]));
      const tool = createAgentTools().find(
        t => t.name === 'get_recent_activity',
      )!;

      // "false" is truthy and "true" is a string: either way a truthiness test
      // answers a different question than the model asked, and the reply would
      // not say so.
      for (const onlyInvolvingMe of ['true', 'false', 1, 0]) {
        const result = requireRecord(
          await tool.handler({ onlyInvolvingMe }, makeTurnContext(currentUser)),
        );
        expect(result.error).toContain('onlyInvolvingMe');
        expect(result.activity).toBeUndefined();
      }
      expect(mockGetZapActivity).not.toHaveBeenCalled();
    });

    test('accepts onlyInvolvingMe: false as a real filter choice', async () => {
      mockGetZapActivity.mockResolvedValue(activityResult([]));
      const tool = createAgentTools().find(
        t => t.name === 'get_recent_activity',
      )!;

      await tool.handler(
        { onlyInvolvingMe: false },
        makeTurnContext(currentUser),
      );
      expect(mockGetZapActivity).toHaveBeenLastCalledWith({
        limit: 20,
        userAadObjectId: undefined,
      });
    });

    test('falls back to the defaults when the arguments are not an object', async () => {
      mockGetZapActivity.mockResolvedValue(activityResult([]));
      const tool = createAgentTools().find(
        t => t.name === 'get_recent_activity',
      )!;

      // The Foundry runner refuses these before a handler sees them, so
      // this exercises the handler's own guard: the exported contract takes
      // `unknown`, and a handler must not crash on one.
      for (const args of [null, undefined, 'all of them', 7, []]) {
        await tool.handler(args, makeTurnContext(currentUser));
        expect(mockGetZapActivity).toHaveBeenLastCalledWith({
          limit: 20,
          userAadObjectId: undefined,
        });
      }
    });
  });

  describe('propose_zap', () => {
    // The turn-state snapshot deliberately claims MORE than the live wallet
    // (5000 vs 900 sats): any check that trusts the snapshot instead of the
    // live getUserWallets read lets the 901-sat proposal through.
    const sender: User = {
      ...currentUser,
      allowanceWallet: wallet({ name: 'Allowance', balance_msat: 5000000 }),
    };
    const bob: User = {
      ...currentUser,
      id: 'user-bob',
      displayName: 'Bob Smith',
      aadObjectId: 'aad-bob',
    };

    const tool = () => createAgentTools().find(t => t.name === 'propose_zap')!;

    const sentCard = (context: TurnContext): ZapCardForTest => {
      const send = context.sendActivity as unknown as {
        mock: { calls: Partial<Activity>[][] };
      };
      const content = send.mock.calls[0][0].attachments?.[0]?.content as
        ZapCardForTest | undefined;
      if (!content) {
        throw new Error('Expected propose_zap to send an adaptive card.');
      }
      return content;
    };

    beforeEach(() => {
      mockGetUserWallets.mockResolvedValue([
        wallet({ name: 'Allowance', balance_msat: 900000 }),
      ]);
      mockGetUsers.mockResolvedValue([sender, bob]);
      mockGetWalletBalance.mockResolvedValue(900);
    });

    test('is flagged sideEffect, so the dispatch proposal guard applies', () => {
      expect(tool().sideEffect).toBe(true);
    });

    test('posts a card pre-filled with recipient, amount and memo, and returns a proposal, not a payment', async () => {
      const context = makeTurnContext(sender);
      const result = requireRecord(
        await tool().handler(
          { recipientName: 'bob', amountSats: 100, memo: 'for the demo' },
          context,
        ),
      );

      expect(result).toEqual({
        proposed: true,
        recipient: 'Bob Smith',
        amountSats: 100,
        memo: 'for the demo',
      });
      expect(context.sendActivity).toHaveBeenCalledTimes(1);

      const inputs = new Map(
        sentCard(context)
          .body.filter(element => element.id !== undefined)
          .map(element => [element.id, element.value] as const),
      );
      expect(inputs.get('zapReceiverId')).toBe('user-bob');
      expect(inputs.get('zapMessage')).toBe('for the demo');
      expect(inputs.get('zapAmount')).toBe('100');
    });

    test('refuses 901 sats against a live Allowance balance of 900, ignoring the stale snapshot', async () => {
      const context = makeTurnContext(sender);
      const result = requireRecord(
        await tool().handler(
          { recipientName: 'bob', amountSats: 901, memo: 'Thanks' },
          context,
        ),
      );

      expect(result).toEqual({
        proposed: false,
        reason:
          'The requested 901 sats exceeds the current Allowance balance of 900 sats.',
      });
      expect(context.sendActivity).not.toHaveBeenCalled();
    });

    test('proposes exactly the full live balance (900 of 900 sats)', async () => {
      const context = makeTurnContext(sender);
      const result = requireRecord(
        await tool().handler(
          { recipientName: 'bob', amountSats: 900, memo: 'all in' },
          context,
        ),
      );

      expect(result.proposed).toBe(true);
      expect(context.sendActivity).toHaveBeenCalledTimes(1);
    });

    test('throws when the sender has no Allowance wallet', async () => {
      mockGetUserWallets.mockResolvedValue([
        wallet({ name: 'Private', balance_msat: 900000 }),
      ]);

      await expect(
        tool().handler(
          { recipientName: 'bob', amountSats: 100, memo: 'x' },
          makeTurnContext(sender),
        ),
      ).rejects.toThrow(
        'Alice has no Allowance wallet, so no zap was proposed.',
      );
    });

    test('refuses a self-zap with its own reason, without posting a card', async () => {
      const context = makeTurnContext(sender);
      const result = requireRecord(
        await tool().handler(
          { recipientName: 'alice', amountSats: 100, memo: 'me' },
          context,
        ),
      );

      expect(result).toEqual({
        proposed: false,
        reason:
          'Users cannot zap themselves — the allowance is for recognising others.',
      });
      expect(context.sendActivity).not.toHaveBeenCalled();
    });

    test('prefers an exact display-name match over substring matches', async () => {
      mockGetUsers.mockResolvedValue([
        sender,
        bob,
        {
          ...bob,
          id: 'user-bob2',
          displayName: 'Bob',
          aadObjectId: 'aad-bob2',
        },
      ]);
      const context = makeTurnContext(sender);

      const result = requireRecord(
        await tool().handler(
          { recipientName: 'Bob', amountSats: 100, memo: 'thanks' },
          context,
        ),
      );

      expect(result.proposed).toBe(true);
      expect(result.recipient).toBe('Bob');
      expect(
        sentCard(context).body.find(element => element.id === 'zapReceiverId')
          ?.value,
      ).toBe('user-bob2');
    });

    test('reports ambiguous and unknown recipients instead of guessing', async () => {
      mockGetUsers.mockResolvedValue([
        sender,
        bob,
        {
          ...bob,
          id: 'user-bobby',
          displayName: 'Bobby Jones',
          aadObjectId: 'aad-bobby',
        },
      ]);
      const context = makeTurnContext(sender);

      const ambiguous = requireRecord(
        await tool().handler(
          { recipientName: 'bob', amountSats: 100, memo: 'x' },
          context,
        ),
      );
      expect(ambiguous.proposed).toBe(false);
      expect(ambiguous.candidates).toEqual(['Bob Smith', 'Bobby Jones']);

      const unknown = requireRecord(
        await tool().handler(
          { recipientName: 'zoe', amountSats: 100, memo: 'x' },
          context,
        ),
      );
      expect(unknown.proposed).toBe(false);
      expect(unknown.reason).toBe('No teammate matches "zoe".');
      expect(unknown.teammates).toContain('Bob Smith');

      expect(context.sendActivity).not.toHaveBeenCalled();
    });

    test('names the offending field and value in each validation reason', async () => {
      const context = makeTurnContext(sender);
      const run = (args: unknown) => tool().handler(args, context);

      await expect(
        run({ recipientName: '', amountSats: 100, memo: 'x' }),
      ).resolves.toEqual({
        proposed: false,
        reason: 'recipientName must be a non-empty string, received: "".',
      });

      await expect(
        run({ recipientName: 'bob', amountSats: 10.5, memo: 'x' }),
      ).resolves.toEqual({
        proposed: false,
        reason: `amountSats must be a whole number between 1 and ${MAX_ZAP_SATS}, received: 10.5.`,
      });

      // Foundry sends whatever the model wrote — a stringified number must
      // be refused, not coerced.
      for (const amountSats of ['100', 0, MAX_ZAP_SATS + 1]) {
        const result = requireRecord(
          await run({
            recipientName: 'bob',
            amountSats,
            memo: 'x',
          }),
        );
        expect(result.proposed).toBe(false);
        expect(result.reason).toContain('amountSats');
        expect(result.reason).toContain(JSON.stringify(amountSats));
      }

      await expect(
        run({ recipientName: 'bob', amountSats: 100, memo: '  ' }),
      ).resolves.toEqual({
        proposed: false,
        reason:
          'memo must be a non-empty string saying why the recipient is recognised, received: "  ".',
      });

      expect(context.sendActivity).not.toHaveBeenCalled();
      expect(mockGetUserWallets).not.toHaveBeenCalled();
    });

    test('throws when there is no current user in turn state', async () => {
      await expect(
        tool().handler(
          { recipientName: 'bob', amountSats: 100, memo: 'x' },
          makeTurnContext(undefined),
        ),
      ).rejects.toThrow(/no current user in turn state/);
    });
  });

  describe('Microsoft Graph tools', () => {
    const originalConnectionName = process.env.GRAPH_CONNECTION_NAME;

    const makeGraphContext = (token?: string): TurnContext => {
      const userTokenClientKey = Symbol('UserTokenClientKey');
      const turnState = new Map<unknown, unknown>();
      turnState.set(userTokenClientKey, {
        getUserToken: jest
          .fn<() => Promise<{ token: string } | undefined>>()
          .mockResolvedValue(token ? { token } : undefined),
      });
      return {
        turnState,
        adapter: { UserTokenClientKey: userTokenClientKey },
        activity: { from: { id: 'teams-user' }, channelId: 'msteams' },
      } as unknown as TurnContext;
    };

    beforeEach(() => {
      process.env.GRAPH_CONNECTION_NAME = 'GraphWorkSignals';
    });

    afterEach(() => {
      if (originalConnectionName === undefined) {
        delete process.env.GRAPH_CONNECTION_NAME;
      } else {
        process.env.GRAPH_CONNECTION_NAME = originalConnectionName;
      }
    });

    test('uses delegated tokens and clamps the meeting look-back window', async () => {
      mockGetRecentMeetings.mockResolvedValue([]);
      const tool = createAgentTools().find(
        item => item.name === 'get_recent_meetings',
      )!;

      await expect(
        tool.handler({ days: 90 }, makeGraphContext('graph-token')),
      ).resolves.toEqual({ connected: true, periodDays: 30, meetings: [] });
      expect(mockGetRecentMeetings).toHaveBeenCalledWith('graph-token', 30);
    });

    test('returns a connection instruction instead of calling Graph without a token', async () => {
      const tool = createAgentTools().find(
        item => item.name === 'get_recent_meetings',
      )!;

      const result = requireRecord(await tool.handler({}, makeGraphContext()));

      expect(result).toMatchObject({ connected: false });
      expect(result.message).toMatch(/connect calendar/);
      expect(mockGetRecentMeetings).not.toHaveBeenCalled();
    });

    test('falls back to the default window when the arguments are not an object', async () => {
      mockGetRecentMeetings.mockResolvedValue([]);
      const tool = createAgentTools().find(
        item => item.name === 'get_recent_meetings',
      )!;

      for (const args of [null, [], 'last week']) {
        await expect(
          tool.handler(args, makeGraphContext('graph-token')),
        ).resolves.toEqual({ connected: true, periodDays: 7, meetings: [] });
        expect(mockGetRecentMeetings).toHaveBeenLastCalledWith(
          'graph-token',
          7,
        );
      }
    });

    test('rejects unknown arguments on the Graph tools rather than ignoring them', async () => {
      mockGetRecentMeetings.mockResolvedValue([]);
      mockGetRelevantPeople.mockResolvedValue([]);

      const meetings = requireRecord(
        await createAgentTools()
          .find(item => item.name === 'get_recent_meetings')!
          .handler({ weeks: 2 }, makeGraphContext('graph-token')),
      );
      expect(meetings.error).toContain('weeks');
      expect(mockGetRecentMeetings).not.toHaveBeenCalled();

      const collaborators = requireRecord(
        await createAgentTools()
          .find(item => item.name === 'get_frequent_collaborators')!
          .handler({ top: 3 }, makeGraphContext('graph-token')),
      );
      expect(collaborators.error).toContain('top');
      expect(mockGetRelevantPeople).not.toHaveBeenCalled();
    });

    test('returns relevant collaborators without exposing message content', async () => {
      mockGetRelevantPeople.mockResolvedValue([
        { name: 'Ada', email: 'ada@zaplie.test' },
      ]);
      const tool = createAgentTools().find(
        item => item.name === 'get_frequent_collaborators',
      )!;

      await expect(
        tool.handler({}, makeGraphContext('graph-token')),
      ).resolves.toEqual({
        connected: true,
        collaborators: [{ name: 'Ada', email: 'ada@zaplie.test' }],
      });
    });

    test('does not register Graph tools when the connection is disabled', () => {
      delete process.env.GRAPH_CONNECTION_NAME;

      expect(createAgentTools().map(tool => tool.name)).not.toContain(
        'get_recent_meetings',
      );
    });
  });
});
