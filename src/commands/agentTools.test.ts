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
import { getRecentZaps } from '../services/zapHistoryService';
import { getRecentMeetings, getRelevantPeople } from '../services/graphService';
import {
  afterEach,
  expect,
  describe,
  test,
  beforeEach,
  jest,
} from '@jest/globals';
import { TurnContext } from 'botbuilder';

jest.mock('../services/lnbitsService');
jest.mock('../services/zapHistoryService');
jest.mock('../services/graphService');

const mockGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;
const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;
const mockGetRecentZaps = getRecentZaps as jest.MockedFunction<
  typeof getRecentZaps
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error('Expected the tool to return an object.');
  }
  return value;
};

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
  });

  describe('get_leaderboard', () => {
    test('enumerates every user and ranks their Private wallets', async () => {
      mockGetUsers.mockResolvedValue([
        { ...currentUser, id: 'user-bob', displayName: 'Bob' },
        { ...currentUser, id: 'user-alice', displayName: 'Alice' },
        { ...currentUser, id: 'user-charlie', displayName: 'Charlie' },
      ]);
      mockGetUserWallets.mockImplementation(async (_adminKey, userId) => {
        if (userId === 'user-bob') {
          return [
            wallet({
              id: 'w-bob',
              name: 'Private',
              user: userId,
              balance_msat: 500000,
            }),
          ];
        }
        if (userId === 'user-alice') {
          return [
            wallet({ name: 'Allowance', user: userId }),
            wallet({
              id: 'w-alice',
              name: 'Private',
              user: userId,
              balance_msat: 1500000,
            }),
          ];
        }
        return [wallet({ name: 'LNbits wallet', user: userId })];
      });

      const tool = createAgentTools().find(t => t.name === 'get_leaderboard')!;
      const result = requireRecord(
        await tool.handler({}, makeTurnContext(currentUser)),
      );

      expect(result.leaderboard).toEqual([
        { displayName: 'Alice', balanceSats: 1500 },
        { displayName: 'Bob', balanceSats: 500 },
      ]);
      expect(mockGetUserWallets.mock.calls.map(([, userId]) => userId)).toEqual(
        ['user-bob', 'user-alice', 'user-charlie'],
      );
    });
  });

  describe('get_recent_activity', () => {
    test('passes limit and onlyInvolvingMe through to getRecentZaps', async () => {
      mockGetRecentZaps.mockResolvedValue([
        {
          from: { ...currentUser, displayName: 'Alice' },
          to: { ...currentUser, displayName: 'Bob' },
          amountSats: 100,
          memo: 'Great work!',
          time: new Date('2026-07-15T10:00:00Z'),
        },
      ]);

      const tool = createAgentTools().find(
        t => t.name === 'get_recent_activity',
      )!;
      const result = requireRecord(
        await tool.handler(
          { limit: 10, onlyInvolvingMe: true },
          makeTurnContext(currentUser),
        ),
      );

      expect(mockGetRecentZaps).toHaveBeenCalledWith({
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
      mockGetRecentZaps.mockResolvedValue([]);

      const tool = createAgentTools().find(
        t => t.name === 'get_recent_activity',
      )!;

      await tool.handler({ limit: 500 }, makeTurnContext(currentUser));
      expect(mockGetRecentZaps).toHaveBeenLastCalledWith({
        limit: 50,
        userAadObjectId: undefined,
      });

      // A negative limit must not flow through to Array.prototype.slice,
      // where slice(0, -1) would return almost everything instead of a
      // small capped list.
      await tool.handler({ limit: -1 }, makeTurnContext(currentUser));
      expect(mockGetRecentZaps).toHaveBeenLastCalledWith({
        limit: 1,
        userAadObjectId: undefined,
      });

      await tool.handler({}, makeTurnContext(currentUser));
      expect(mockGetRecentZaps).toHaveBeenLastCalledWith({
        limit: 20,
        userAadObjectId: undefined,
      });
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

    type CardElement = { id?: string; value?: unknown };
    const sentCard = (context: TurnContext) => {
      const activity = (context.sendActivity as jest.Mock).mock.calls[0][0] as {
        attachments: Array<{ content: { body: CardElement[] } }>;
      };
      return activity.attachments[0].content;
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
          .body.filter(el => el.id)
          .map(el => [el.id as string, el] as const),
      );
      expect(inputs.get('zapReceiverId').value).toBe('user-bob');
      expect(inputs.get('zapMessage').value).toBe('for the demo');
      expect(inputs.get('zapAmount').value).toBe('100');
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
        sentCard(context).body.find(el => el.id === 'zapReceiverId').value,
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

      const result = (await tool.handler({}, makeGraphContext())) as {
        connected: boolean;
        message: string;
      };

      expect(result).toMatchObject({ connected: false });
      expect(result.message).toMatch(/connect calendar/);
      expect(mockGetRecentMeetings).not.toHaveBeenCalled();
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
