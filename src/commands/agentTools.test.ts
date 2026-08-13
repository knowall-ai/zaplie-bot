// agentTools.test.ts
//
// Mocks lnbitsService/zapHistoryService (external dependencies), not
// agentTools itself.

import { createAgentTools } from './agentTools';
import {
  getUserWallets,
  getWallets,
  getUsers,
} from '../services/lnbitsService';
import { getRecentZaps } from '../services/zapHistoryService';
import { createZapCard } from './sendZapCommand';
import { expect, describe, test, beforeEach, jest } from '@jest/globals';
import { TurnContext } from 'botbuilder';

jest.mock('../services/lnbitsService');
jest.mock('../services/zapHistoryService');
jest.mock('./sendZapCommand');

const mockGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;
const mockGetWallets = getWallets as jest.MockedFunction<typeof getWallets>;
const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;
const mockGetRecentZaps = getRecentZaps as jest.MockedFunction<
  typeof getRecentZaps
>;
const mockCreateZapCard = createZapCard as jest.MockedFunction<
  typeof createZapCard
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
    sendActivity: jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
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

      const tool = createAgentTools().find(t => t.name === 'get_my_balance')!;
      const result: any = await tool.handler({}, makeTurnContext(currentUser));

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
          user: currentUser.id,
          balance_msat: 1500000,
        }),
      ]);
      mockGetUsers.mockResolvedValue([
        { ...currentUser, id: 'user-bob', displayName: 'Bob' },
        currentUser,
      ]);

      const tool = createAgentTools().find(t => t.name === 'get_leaderboard')!;
      const result: any = await tool.handler({}, makeTurnContext(currentUser));

      expect(result.leaderboard).toEqual([
        { displayName: 'Alice', balanceSats: 1500, isCurrentUser: true },
        { displayName: 'Bob', balanceSats: 500, isCurrentUser: false },
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

      const tool = createAgentTools().find(
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
    const sender: User = {
      ...currentUser,
      allowanceWallet: wallet({ balance_msat: 900000 }),
    };
    const bob: User = {
      ...currentUser,
      id: 'user-bob',
      displayName: 'Bob Smith',
      aadObjectId: 'aad-bob',
    };
    const tool = () => createAgentTools().find(t => t.name === 'propose_zap')!;

    beforeEach(() => {
      mockGetUsers.mockResolvedValue([sender, bob]);
      mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as any);
    });

    test('posts a pre-filled proposal without executing a payment', async () => {
      const context = makeTurnContext(sender);
      const result: any = await tool().handler(
        { recipientName: 'Bob', amountSats: 100, memo: 'Great review' },
        context,
      );

      expect(mockCreateZapCard).toHaveBeenCalledWith(
        sender,
        process.env.LNBITS_POINTS_LABEL,
        { receiverId: 'user-bob', message: 'Great review', amountSats: 100 },
      );
      expect(context.sendActivity).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        proposed: true,
        recipient: 'Bob Smith',
        amountSats: 100,
        memo: 'Great review',
      });
    });

    test('prefers an exact display name over partial matches', async () => {
      const exactBob = { ...bob, id: 'user-exact', displayName: 'Bob' };
      mockGetUsers.mockResolvedValue([sender, bob, exactBob]);

      await tool().handler(
        { recipientName: 'Bob', amountSats: 25, memo: 'Thanks' },
        makeTurnContext(sender),
      );

      expect(mockCreateZapCard).toHaveBeenCalledWith(
        sender,
        process.env.LNBITS_POINTS_LABEL,
        expect.objectContaining({ receiverId: 'user-exact' }),
      );
    });

    test.each([
      ['a self-zap', { recipientName: 'Alice', amountSats: 10, memo: 'Me' }],
      ['a missing reason', { recipientName: 'Bob', amountSats: 10, memo: '' }],
      [
        'a fractional amount',
        { recipientName: 'Bob', amountSats: 1.5, memo: 'Thanks' },
      ],
      [
        'an excessive amount',
        { recipientName: 'Bob', amountSats: 10001, memo: 'Thanks' },
      ],
    ])('refuses %s without posting a card', async (_label, args) => {
      const context = makeTurnContext(sender);
      const result: any = await tool().handler(args, context);

      expect(result.proposed).toBe(false);
      expect(context.sendActivity).not.toHaveBeenCalled();
    });

    test('returns candidates instead of guessing an ambiguous name', async () => {
      mockGetUsers.mockResolvedValue([
        sender,
        bob,
        { ...bob, id: 'user-bobby', displayName: 'Bobby Jones' },
      ]);

      const result: any = await tool().handler(
        { recipientName: 'bob', amountSats: 10, memo: 'Thanks' },
        makeTurnContext(sender),
      );

      expect(result).toMatchObject({
        proposed: false,
        candidates: ['Bob Smith', 'Bobby Jones'],
      });
    });
  });
});
