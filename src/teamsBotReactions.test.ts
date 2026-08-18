// teamsBotReactions.test.ts — ⚡ reaction on a bot zap card pays its recipient.
import {
  expect,
  describe,
  test,
  beforeEach,
  afterAll,
  jest,
} from '@jest/globals';

const originalPointsLabel = process.env.LNBITS_POINTS_LABEL;
const originalAdminKey = process.env.LNBITS_ADMINKEY;

process.env.LNBITS_POINTS_LABEL = 'Sats';
process.env.LNBITS_ADMINKEY = 'admin-key';

jest.mock('./services/lnbitsService');
jest.mock('./commands/sendZapCommand', () => {
  const actual = jest.requireActual('./commands/sendZapCommand') as object;
  return {
    ...actual,
    createZapCard: jest.fn(),
    SendZap: jest.fn(),
  };
});

import { getUser, getWalletBalance } from './services/lnbitsService';
import { SendZap } from './commands/sendZapCommand';
import {
  registerZapTarget,
  resetZapTargetsForTests,
  ZAP_REACTION_DEFAULT_SATS,
} from './services/reactionZapTargets';

// require, not import: imports hoist above the jest.mock calls above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TeamsBot } = require('./teamsBot') as typeof import('./teamsBot');

const mockGetUser = getUser as jest.MockedFunction<typeof getUser>;
const mockGetWalletBalance = getWalletBalance as jest.MockedFunction<
  typeof getWalletBalance
>;
const mockSendZap = SendZap as jest.MockedFunction<typeof SendZap>;

const reactor = {
  id: 'reactorId',
  displayName: 'Reactor',
  profileImg: '',
  aadObjectId: 'aad-reactor',
  email: 'reactor@test.com',
  privateWallet: null,
  allowanceWallet: {
    id: 'wallet-reactor',
    inkey: 'reactor-inkey',
    adminkey: 'reactor-adminkey',
  },
} as unknown as User;

const receiver = {
  id: 'receiverId',
  displayName: 'Receiver',
  profileImg: '',
  aadObjectId: 'aad-receiver',
  email: 'receiver@test.com',
  privateWallet: { id: 'wallet-receiver', inkey: 'receiver-inkey' },
  allowanceWallet: null,
} as unknown as User;

function buildReactionContext(
  reactionType: string,
  replyToId: string | undefined,
) {
  const turnState = new Map<string, unknown>();
  turnState.set('user', reactor);
  return {
    turnState,
    activity: {
      replyToId,
      reactionsAdded: [{ type: reactionType }],
      conversation: { id: 'conv-1', tenantId: 'tenant-1' },
      from: { id: 'teams-reactor' },
    },
    sendActivity: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as import('botbuilder').TurnContext;
}

describe('TeamsBot handleZapReaction', () => {
  let bot: InstanceType<typeof TeamsBot>;

  beforeEach(() => {
    jest.clearAllMocks();
    resetZapTargetsForTests();
    bot = new TeamsBot();
    mockGetWalletBalance.mockResolvedValue(1000);
    mockGetUser.mockResolvedValue(receiver);
    mockSendZap.mockResolvedValue({} as never);
  });

  afterAll(() => {
    restoreEnv('LNBITS_POINTS_LABEL', originalPointsLabel);
    restoreEnv('LNBITS_ADMINKEY', originalAdminKey);
  });

  test('a zap reaction on a registered card pays and confirms', async () => {
    registerZapTarget('conv-1', 'card-1', receiver.id);
    const context = buildReactionContext('26a1_highvoltagesymbol', 'card-1');

    await bot.handleZapReaction(context);

    expect(mockSendZap).toHaveBeenCalledTimes(1);
    expect(mockSendZap).toHaveBeenCalledWith(
      reactor,
      receiver,
      'Zapped with a ⚡ reaction',
      ZAP_REACTION_DEFAULT_SATS,
      context,
      false,
      'Sats',
    );
    expect(context.sendActivity).toHaveBeenCalledWith(
      `⚡ Sent ${ZAP_REACTION_DEFAULT_SATS} Sats to Receiver for your reaction.`,
    );
  });

  test('non-zap reaction types do not pay', async () => {
    registerZapTarget('conv-1', 'card-1', receiver.id);
    const context = buildReactionContext('heart', 'card-1');

    await bot.handleZapReaction(context);

    expect(mockSendZap).not.toHaveBeenCalled();
    expect(context.sendActivity).not.toHaveBeenCalled();
  });

  test('reactions on unregistered messages are ignored', async () => {
    const context = buildReactionContext('26a1_highvoltagesymbol', 'card-x');

    await bot.handleZapReaction(context);

    expect(mockSendZap).not.toHaveBeenCalled();
    expect(context.sendActivity).not.toHaveBeenCalled();
  });

  test('a second zap reaction on the same card stays silent and pays once', async () => {
    registerZapTarget('conv-1', 'card-1', receiver.id);
    const first = buildReactionContext('26a1_highvoltagesymbol', 'card-1');
    const second = buildReactionContext('26a1_highvoltagesymbol', 'card-1');

    await bot.handleZapReaction(first);
    await bot.handleZapReaction(second);

    expect(mockSendZap).toHaveBeenCalledTimes(1);
    expect(second.sendActivity).not.toHaveBeenCalled();
  });

  test('a failed balance read answers with the error, not silence', async () => {
    registerZapTarget('conv-1', 'card-1', receiver.id);
    mockGetWalletBalance.mockRejectedValue(new Error('LNbits unavailable'));
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const context = buildReactionContext('26a1_highvoltagesymbol', 'card-1');

    await bot.handleZapReaction(context);

    expect(mockSendZap).not.toHaveBeenCalled();
    expect(context.sendActivity).toHaveBeenCalledWith(
      "D'oh! LNbits unavailable",
    );
    errorSpy.mockRestore();
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
