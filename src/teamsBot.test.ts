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
import { SSOCommand, SSOCommandMap } from './commands/SSOCommandMap';
import {
  createInvoice,
  getUser,
  getWalletBalance,
  payInvoice,
} from './services/lnbitsService';

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
// eslint-disable-next-line @typescript-eslint/no-require-imports
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

class SpyCommand extends SSOCommand {
  execute = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
}

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

describe('TeamsBot withdraw command', () => {
  test('neither runs nor advertises the unlisted withdraw command', async () => {
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      text: 'withdraw my zaps',
      conversation: {
        id: 'conv-2',
        conversationType: 'channel',
        tenantId: 'tenant-1',
      },
    });

    await bot.run(context);

    // The stub would have replied "coming soon", so a lone unrecognized
    // command reply proves it was not invoked.
    expect(sendActivity).toHaveBeenCalledTimes(1);
    const [reply] = sendActivity.mock.calls[0] as unknown as [string];
    expect(reply).toContain("D'oh!");
    expect(reply).not.toContain('withdraw');
  });
});

describe('TeamsBot submitZaps message validation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const zapSubmitter = {
    id: 'user-1',
    aadObjectId: 'aad-user-1',
    allowanceWallet: { id: 'wallet-1', inkey: 'inkey', adminkey: 'adminkey' },
  };

  test('rejects a submit whose scope cannot be identified at all', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const bot = new TeamsBot();
    // No tenant on the conversation and none in channelData: the ledger key
    // would have to be guessed, which could merge unrelated submissions.
    const { context, sendActivity } = makeContext({
      replyToId: 'card-1',
      conversation: { id: 'conv-1', conversationType: 'personal' },
      value: {
        action: 'submitZaps',
        zapReceiverId: 'recipient-1',
        zapAmount: '10',
        zapMessage: 'nice work',
      },
    });
    (context.turnState as Map<unknown, unknown>).set('user', zapSubmitter);

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledWith(
      'That zap card cannot be identified, so it was not submitted. Please start a new zap.',
    );
    expect(context.updateActivity).not.toHaveBeenCalled();
  });

  test('accepts a submit whose tenant id arrives only in channelData', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      replyToId: 'card-1',
      conversation: { id: 'conv-1', conversationType: 'personal' },
      channelData: { tenant: { id: 'tenant-1' } },
      value: {
        action: 'submitZaps',
        zapReceiverId: 'recipient-1',
        zapAmount: '10',
      },
    });
    (context.turnState as Map<unknown, unknown>).set('user', zapSubmitter);

    await bot.run(context);

    // It gets past scope validation and fails on the missing message instead,
    // which is the next check - the tenant was found, not guessed.
    expect(sendActivity).toHaveBeenCalledWith(
      "D'oh! Your zap needs a message, so no zaps were sent.",
    );
  });

  test('rejects a submit with no message instead of building a receipt from it', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      replyToId: 'card-1',
      value: {
        action: 'submitZaps',
        zapReceiverId: 'recipient-1',
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
      "D'oh! Your zap needs a message, so no zaps were sent.",
    );
    expect(context.updateActivity).not.toHaveBeenCalled();
  });
});

describe('TeamsBot command matching', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('runs a command when the message merely starts with it', async () => {
    const bot = new TeamsBot();
    const spy = new SpyCommand();
    SSOCommandMap.register('send zap', spy);
    const { context } = makeContext({ text: 'Send   Zap to bob please' });

    await bot.run(context);

    expect(spy.execute).toHaveBeenCalledTimes(1);
  });

  test('lists the known commands when a channel message matches nothing', async () => {
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      text: 'what can you do?',
      conversation: {
        id: 'conv-2',
        conversationType: 'channel',
        tenantId: 'tenant-1',
      },
    });

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledTimes(1);
    const [guide] = sendActivity.mock.calls[0] as unknown as [string];
    expect(guide).toContain("D'oh!");
    expect(guide).toContain('send zap');
    expect(guide).toContain('show my balance');
    expect(guide).toContain('show leaderboard');
  });
});

describe('TeamsBot welcome message', () => {
  test('welcomes with the command list when the bot itself is added', async () => {
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      type: 'conversationUpdate',
      text: undefined,
      membersAdded: [{ id: 'bot-id' }],
    });

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledTimes(1);
    const [welcome] = sendActivity.mock.calls[0] as unknown as [string];
    expect(welcome).toContain('send zap');
    expect(welcome).toContain('show leaderboard');
  });

  test('stays quiet when only a regular member is added', async () => {
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      type: 'conversationUpdate',
      text: undefined,
      membersAdded: [{ id: 'someone-else' }],
    });

    await bot.run(context);

    expect(sendActivity).not.toHaveBeenCalled();
  });
});

// Handler-level proof that one zap card pays each recipient at most once,
// driven through bot.run() with the LNbits boundary mocked.
describe('TeamsBot pays a zap card at most once per recipient', () => {
  const receiver: User = {
    id: 'recipient-1',
    displayName: 'Bob',
    profileImg: '',
    aadObjectId: 'aad-bob',
    email: 'bob@example.test',
    privateWallet: {
      id: 'w-bob-priv',
      admin: '',
      name: 'Private',
      user: 'recipient-1',
      adminkey: 'adm-bob-priv',
      inkey: 'ink-bob-priv',
      balance_msat: 0,
      deleted: false,
    },
    allowanceWallet: null,
  };

  const submitContext = (cardId: string): MockContext => {
    const mock = makeContext({
      replyToId: cardId,
      value: {
        action: 'submitZaps',
        zapReceiverId: 'recipient-1',
        zapMessage: 'thanks!',
        zapAmount: '10',
      },
    });
    (mock.context.turnState as Map<unknown, unknown>).set('user', {
      id: 'user-1',
      displayName: 'Alice',
      aadObjectId: 'aad-user-1',
      privateWallet: null,
      allowanceWallet: {
        id: 'w-alice-allow',
        inkey: 'ink-alice-allow',
        adminkey: 'adm-alice-allow',
      },
    });
    return mock;
  };

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.mocked(getUser).mockResolvedValue(receiver);
    jest.mocked(getWalletBalance).mockResolvedValue(1000);
    jest.mocked(createInvoice).mockResolvedValue('lnbc1-payment-request');
    jest.mocked(payInvoice).mockResolvedValue({ payment_hash: 'hash-1' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('pays once when the same card is submitted twice in a row', async () => {
    const bot = new TeamsBot();
    const first = submitContext('card-dup');
    const second = submitContext('card-dup');

    await bot.run(first.context);
    await bot.run(second.context);

    expect(payInvoice).toHaveBeenCalledTimes(1);
    // The paid submit reads the balance twice (budget check, receipt); the
    // duplicate is stopped before it touches LNbits at all.
    expect(getWalletBalance).toHaveBeenCalledTimes(2);
    expect(first.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Awesome! You sent 10'),
    );
    expect(second.sendActivity).toHaveBeenCalledWith(
      'That zap card was already submitted, so nothing was sent again.',
    );
  });

  test('pays once when two submits of the same card race', async () => {
    const bot = new TeamsBot();
    const first = submitContext('card-race');
    const second = submitContext('card-race');
    // Hold both submits at the balance read, which sits between the pending
    // check and the acquire, so the interleaving is the test's own doing
    // rather than the scheduler's.
    let releaseBalance: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      releaseBalance = resolve;
    });
    jest.mocked(getWalletBalance).mockImplementation(async () => {
      await gate;
      return 1000;
    });

    const runs = Promise.all([bot.run(first.context), bot.run(second.context)]);
    await new Promise(resolve => setImmediate(resolve));
    releaseBalance();
    await runs;

    expect(payInvoice).toHaveBeenCalledTimes(1);
    // Three balance reads: both submits passed the pending check while the
    // ledger was still empty, then the winner read it again for the receipt.
    expect(getWalletBalance).toHaveBeenCalledTimes(3);
    const replies = [
      ...first.sendActivity.mock.calls,
      ...second.sendActivity.mock.calls,
    ].map(([message]) => message);
    expect(replies).toContainEqual(
      expect.stringMatching(/already submitted|still need checking/),
    );
    expect(replies).toContainEqual(
      expect.stringContaining('Awesome! You sent 10'),
    );
  });

  // The balance read and the card rewrite happen after the money has moved.
  // Failing them used to fall into the handler's catch, so a user whose zap
  // had settled was told it had not.
  test('still reports success when the post-payment balance read fails', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const bot = new TeamsBot();
    const submit = submitContext('card-balance-fails');
    let reads = 0;
    jest.mocked(getWalletBalance).mockImplementation(async () => {
      reads += 1;
      // The budget check passes; the receipt read is the one that fails.
      if (reads > 1) throw new Error('Error getting wallet balance');
      return 1000;
    });

    await bot.run(submit.context);

    expect(payInvoice).toHaveBeenCalledTimes(1);
    expect(submit.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Awesome! You sent 10'),
    );
    expect(submit.sendActivity).not.toHaveBeenCalledWith(GENERIC_ERROR_MESSAGE);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('the payments stand'),
      expect.any(Error),
    );
  });

  test('still reports success when the receipt card cannot be rewritten', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const bot = new TeamsBot();
    const submit = submitContext('card-update-fails');
    (
      submit.context.updateActivity as jest.Mock<() => Promise<void>>
    ).mockRejectedValue(new Error('Activity not found'));

    await bot.run(submit.context);

    expect(payInvoice).toHaveBeenCalledTimes(1);
    expect(submit.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Awesome! You sent 10'),
    );
    expect(submit.sendActivity).not.toHaveBeenCalledWith(GENERIC_ERROR_MESSAGE);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('the payments stand'),
      expect.any(Error),
    );
  });

  test('pays a different card to the same recipient normally', async () => {
    const bot = new TeamsBot();

    await bot.run(submitContext('card-a').context);
    await bot.run(submitContext('card-b').context);

    expect(payInvoice).toHaveBeenCalledTimes(2);
  });
});

// The bot answers in the language of the Teams client: Spanish for any es-*
// locale, English for everything else. Command words stay English.
describe('TeamsBot replies in the user language', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const zapSubmitter = {
    id: 'user-1',
    aadObjectId: 'aad-user-1',
    allowanceWallet: { id: 'wallet-1', inkey: 'inkey', adminkey: 'adminkey' },
  };

  test('welcomes a Spanish client in Spanish, with the English command words', async () => {
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      type: 'conversationUpdate',
      text: undefined,
      locale: 'es-MX',
      membersAdded: [{ id: 'bot-id' }],
    });

    await bot.run(context);

    const [welcome] = sendActivity.mock.calls[0] as unknown as [string];
    expect(welcome).toContain('Soy Zaplie');
    expect(welcome).toContain('send zap');
    expect(welcome).not.toContain("I'm Zaplie");
  });

  test('explains an unrecognized channel command in Spanish', async () => {
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      text: 'hazme rico',
      locale: 'es-ES',
      conversation: {
        id: 'conv-2',
        conversationType: 'channel',
        tenantId: 'tenant-1',
      },
    });

    await bot.run(context);

    const [reply] = sendActivity.mock.calls[0] as unknown as [string];
    expect(reply).toContain('¡Ups! No reconocí ese comando.');
    expect(reply).toContain('show leaderboard');
  });

  test('renders a validation error in Spanish', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      replyToId: 'card-es',
      locale: 'es-419',
      value: {
        action: 'submitZaps',
        zapReceiverId: 'user-1',
        zapMessage: 'gracias',
        zapAmount: '10',
      },
    });
    (context.turnState as Map<unknown, unknown>).set('user', zapSubmitter);

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledWith(
      '¡Ups! No puedes enviarte un zap a ti mismo, así que no se envió ningún zap.',
    );
  });

  test('falls back to English for any other locale', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      replyToId: 'card-fr',
      locale: 'fr-FR',
      value: {
        action: 'submitZaps',
        zapReceiverId: 'user-1',
        zapMessage: 'merci',
        zapAmount: '10',
      },
    });
    (context.turnState as Map<unknown, unknown>).set('user', zapSubmitter);

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledWith(
      "D'oh! You cannot zap yourself, so no zaps were sent.",
    );
  });
});
