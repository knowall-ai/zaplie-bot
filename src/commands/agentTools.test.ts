// agentTools.test.ts
//
// Mocks lnbitsService/zapHistoryService (external dependencies), not
// agentTools itself.

import { createReadOnlyTools } from './agentTools';
import { getUserWallets } from '../services/lnbitsService';
import {
  getRecentZaps,
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
import { TurnContext } from 'botbuilder';

jest.mock('../services/lnbitsService');
jest.mock('../services/zapHistoryService');
jest.mock('../services/graphService');

const mockGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;
const mockGetRecentZaps = getRecentZaps as jest.MockedFunction<
  typeof getRecentZaps
>;
const mockGetZapLeaderboard = getZapLeaderboard as jest.MockedFunction<
  typeof getZapLeaderboard
>;
const mockGetRecentMeetings = getRecentMeetings as jest.MockedFunction<
  typeof getRecentMeetings
>;
const mockGetRelevantPeople = getRelevantPeople as jest.MockedFunction<
  typeof getRelevantPeople
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
  return { turnState } as unknown as TurnContext;
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

      const tool = createReadOnlyTools().find(
        t => t.name === 'get_my_balance',
      )!;
      const result: any = await tool.handler({}, makeTurnContext(currentUser));

      expect(result.wallets).toEqual([
        { name: 'Allowance', balanceSats: 900 },
        { name: 'Private', balanceSats: 50 },
      ]);
    });
  });

  describe('get_leaderboard', () => {
    test('reports sats zapped out of Allowance wallets, never wallet balances', async () => {
      mockGetZapLeaderboard.mockResolvedValue([
        {
          user: { ...currentUser, id: 'user-alice', displayName: 'Alice' },
          zappedSats: 1500,
        },
        {
          user: { ...currentUser, id: 'user-bob', displayName: 'Bob' },
          zappedSats: 500,
        },
      ]);

      const tool = createReadOnlyTools().find(
        t => t.name === 'get_leaderboard',
      )!;
      const result: any = await tool.handler({}, makeTurnContext(currentUser));

      expect(result.leaderboard).toEqual([
        { displayName: 'Alice', zappedSats: 1500 },
        { displayName: 'Bob', zappedSats: 500 },
      ]);
      expect(mockGetUserWallets).not.toHaveBeenCalled();
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

      const tool = createReadOnlyTools().find(
        t => t.name === 'get_recent_activity',
      )!;
      const result: any = await tool.handler(
        { limit: 10, onlyInvolvingMe: true },
        makeTurnContext(currentUser),
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

      const tool = createReadOnlyTools().find(
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
      const tool = createReadOnlyTools().find(
        item => item.name === 'get_recent_meetings',
      )!;

      await expect(
        tool.handler({ days: 90 }, makeGraphContext('graph-token')),
      ).resolves.toEqual({ connected: true, periodDays: 30, meetings: [] });
      expect(mockGetRecentMeetings).toHaveBeenCalledWith('graph-token', 30);
    });

    test('returns a connection instruction instead of calling Graph without a token', async () => {
      const tool = createReadOnlyTools().find(
        item => item.name === 'get_recent_meetings',
      )!;

      const result: any = await tool.handler({}, makeGraphContext());

      expect(result).toMatchObject({ connected: false });
      expect(result.message).toMatch(/connect calendar/);
      expect(mockGetRecentMeetings).not.toHaveBeenCalled();
    });

    test('returns relevant collaborators without exposing message content', async () => {
      mockGetRelevantPeople.mockResolvedValue([
        { name: 'Ada', email: 'ada@zaplie.test' },
      ]);
      const tool = createReadOnlyTools().find(
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

      expect(createReadOnlyTools().map(tool => tool.name)).not.toContain(
        'get_recent_meetings',
      );
    });
  });
});
