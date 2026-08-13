// agentTools.test.ts
//
// Mocks lnbitsService/zapHistoryService (external dependencies), not
// agentTools itself.

import { createReadOnlyTools } from './agentTools';
import {
  getUserWallets,
  getWallets,
  getUsers,
} from '../services/lnbitsService';
import { getRecentZaps } from '../services/zapHistoryService';
import { expect, describe, test, beforeEach, jest } from '@jest/globals';
import { TurnContext } from 'botbuilder';

jest.mock('../services/lnbitsService');
jest.mock('../services/zapHistoryService');

const mockGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;
const mockGetWallets = getWallets as jest.MockedFunction<typeof getWallets>;
const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;
const mockGetRecentZaps = getRecentZaps as jest.MockedFunction<
  typeof getRecentZaps
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
    test('returns wallet balances in sats for the current user', async () => {
      mockGetUserWallets.mockResolvedValue([
        wallet({ name: 'Allowance', balance_msat: 900000 }),
        wallet({ name: 'Private', balance_msat: 50000 }),
      ]);

      const tool = createReadOnlyTools().find(
        t => t.name === 'get_my_balance',
      )!;
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
    test('ranks teammates by Private wallet balance, descending', async () => {
      mockGetWallets.mockResolvedValue([
        wallet({
          id: 'w-bob',
          name: 'Private',
          user: 'user-bob',
          balance_msat: 500000,
        }),
        wallet({
          id: 'w-alice',
          name: 'Private',
          user: 'user-alice',
          balance_msat: 1500000,
        }),
      ]);
      mockGetUsers.mockResolvedValue([
        { ...currentUser, id: 'user-bob', displayName: 'Bob' },
        { ...currentUser, id: 'user-alice', displayName: 'Alice' },
      ]);

      const tool = createReadOnlyTools().find(
        t => t.name === 'get_leaderboard',
      )!;
      const result = requireRecord(
        await tool.handler({}, makeTurnContext(currentUser)),
      );

      expect(result.leaderboard).toEqual([
        { displayName: 'Alice', balanceSats: 1500 },
        { displayName: 'Bob', balanceSats: 500 },
      ]);
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
});
