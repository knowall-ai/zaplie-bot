// teamsBot.test.ts
//
// Mocks the external services; exercises the bot through its public run()
// entry point with plain mock TurnContexts.

import {
  afterEach,
  describe,
  expect,
  jest,
  test,
  beforeEach,
} from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { TurnContext } from 'botbuilder';
import { GENERIC_ERROR_MESSAGE } from './messages';

jest.mock('./services/lnbitsService');
jest.mock('./services/foundryAgentService');
jest.mock('./services/graphService');
jest.mock('./services/zapHistoryService');

// teamsBot.ts refuses to load without the reward label, so it must be set
// before the module is required (which is why this is a require, not a
// hoisted import).
process.env.LNBITS_POINTS_LABEL = process.env.LNBITS_POINTS_LABEL || 'Sats';
// The durable zap ledger refuses to construct without a data directory. The
// path is per worker because sibling suites set and then delete this one.
process.env.ZAPLIE_DATA_DIR = path.join(
  os.tmpdir(),
  `zaplie-test-ledger-${process.pid}`,
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TeamsBot } = require('./teamsBot') as typeof import('./teamsBot');

type MockContext = {
  context: TurnContext;
  sendActivity: jest.Mock;
};

const makeContext = (activity: Record<string, unknown>): MockContext => {
  const sendActivity = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const context = {
    activity: {
      type: 'message',
      channelId: 'msteams',
      recipient: { id: 'bot-id' },
      from: { id: 'user-1' },
      conversation: {
        id: 'conv-1',
        conversationType: 'personal',
        tenantId: 'tenant-1',
      },
      ...activity,
    },
    turnState: new Map<unknown, unknown>(),
    sendActivity,
    updateActivity: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as TurnContext;
  return { context, sendActivity };
};

describe('TeamsBot onMessage error hygiene', () => {
  let consoleError: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('logs the error and sends a generic message instead of error.message', async () => {
    const bot = new TeamsBot();
    // A verified sender with no allowance wallet fails on an internal
    // condition, which is exactly what the catch block must not leak.
    const { context, sendActivity } = makeContext({
      replyToId: 'card-1',
      value: {
        action: 'submitZaps',
        zapReceiverId: 'recipient-1',
        zapMessage: 'thanks!',
        zapAmount: '10',
      },
    });
    (context.turnState as Map<unknown, unknown>).set('user', {
      id: 'user-1',
      aadObjectId: 'aad-user-1',
      allowanceWallet: null,
    });

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledWith(GENERIC_ERROR_MESSAGE);
    for (const [message] of sendActivity.mock.calls as unknown as [string][]) {
      expect(message).not.toContain('sending wallet');
    }
    expect(consoleError).toHaveBeenCalledWith(
      'Error in onMessage handler:',
      expect.objectContaining({
        message: expect.stringContaining('No sending wallet found.'),
      }),
    );
  });

  test('tells an unverified sender why nothing was sent', async () => {
    const bot = new TeamsBot();
    // The sender identity check is user-facing copy, not an internal detail:
    // the person needs to know their zaps did not go out.
    const { context, sendActivity } = makeContext({
      replyToId: 'card-1',
      value: {
        action: 'submitZaps',
        zapReceiverId: 'recipient-1',
        zapMessage: 'thanks!',
        zapAmount: '10',
      },
    });

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledWith(
      "D'oh! Could not verify your sender identity, so no zaps were sent.",
    );
  });

  test('relays user-facing validation messages verbatim', async () => {
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      replyToId: 'card-1',
      value: {
        action: 'submitZaps',
        zapReceiverId: 'user-1',
        zapMessage: 'thanks!',
        zapAmount: '10',
      },
    });
    (context.turnState as Map<unknown, unknown>).set('user', {
      id: 'user-1',
      aadObjectId: 'aad-user-1',
      allowanceWallet: { id: 'wallet-1', inkey: 'inkey', adminkey: 'adminkey' },
    });

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledWith(
      "D'oh! You cannot zap yourself, so no zaps were sent.",
    );
  });
});
