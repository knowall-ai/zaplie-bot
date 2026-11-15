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
import { pulseSettled, resetPulseForTests } from './services/pulse';
import { runConversationalTurn } from './services/foundryAgentService';
import { getWalletBalance, payInvoice } from './services/lnbitsService';
import { createInvoiceForPerson, getPerson } from './services/peopleDirectory';

jest.mock('./services/lnbitsService');
jest.mock('./services/peopleDirectory');
jest.mock('./services/foundryAgentService');
jest.mock('./services/graphService');
jest.mock('./services/zapHistoryService');

// teamsBot.ts refuses to load without the reward label, so it must be set
// before the module is required (which is why this is a require, not a
// hoisted import).
process.env.LNBITS_POINTS_LABEL = process.env.LNBITS_POINTS_LABEL || 'Sats';
// The notifier needs the bot's app id to open a chat.
process.env.BOT_ID = process.env.BOT_ID || 'bot-app-id';
// The durable zap ledger refuses to construct without a data directory. The
// path is per worker because sibling suites set and then delete this one.
process.env.ZAPLIE_DATA_DIR = path.join(
  os.tmpdir(),
  `zaplie-test-ledger-${process.pid}`,
);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TeamsBot } = require('./teamsBot') as typeof import('./teamsBot');
// Required after the env above for the same reason; tests switch the assistant
// on and off through it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = (require('./config') as typeof import('./config')).default;

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

  test('a sender with no Allowance wallet is told to ask an admin', async () => {
    const bot = new TeamsBot();
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

    expect(sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Allowance wallet has not been set up yet'),
    );
  });

  test('logs the error and sends a generic message instead of error.message', async () => {
    const bot = new TeamsBot();
    // An LNbits failure carrying internal detail is exactly what the catch
    // block must not leak.
    jest
      .mocked(getWalletBalance)
      .mockRejectedValueOnce(new Error('No sending wallet found. key 0d1f'));
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
      allowanceWallet: { id: 'w-1', inkey: 'in', adminkey: 'ad' },
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

describe('TeamsBot free text in a 1:1 chat', () => {
  const saved = {
    endpoint: config.foundryProjectEndpoint,
    model: config.foundryModel,
  };

  afterEach(() => {
    config.foundryProjectEndpoint = saved.endpoint;
    config.foundryModel = saved.model;
    jest.restoreAllMocks();
  });

  test.each([
    ['neither is set', undefined, undefined],
    ['only the endpoint is set', 'https://foundry.example', undefined],
    ['only the model is set', undefined, 'model-1'],
  ])(
    'lists the commands instead of failing when the assistant is not configured (%s)',
    async (_case, endpoint, model) => {
      config.foundryProjectEndpoint = endpoint;
      config.foundryModel = model;
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const bot = new TeamsBot();
      const { context, sendActivity } = makeContext({ text: 'Hi Zaplie!' });

      await bot.run(context);

      expect(runConversationalTurn).not.toHaveBeenCalled();
      expect(sendActivity).toHaveBeenCalledTimes(1);
      const [guide] = sendActivity.mock.calls[0] as unknown as [string];
      expect(guide).not.toBe(GENERIC_ERROR_MESSAGE);
      expect(guide).toContain('send zap');
      expect(guide).toContain('show my balance');
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  test('hands free text to the assistant when it is configured', async () => {
    config.foundryProjectEndpoint = 'https://foundry.example';
    config.foundryModel = 'model-1';
    jest.mocked(runConversationalTurn).mockResolvedValueOnce({
      replyText: 'Hello from the assistant',
      foundryConversationId: 'foundry-conv-1',
    });
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({ text: 'Hi Zaplie!' });

    await bot.run(context);

    expect(runConversationalTurn).toHaveBeenCalledTimes(1);
    // The assistant is told the bot's real commands, so it can point people
    // to "send zap" instead of inventing a way to zap.
    const commandNames = jest.mocked(runConversationalTurn).mock.calls[0][4];
    expect(commandNames).toEqual(SSOCommandMap.commandNames());
    expect(commandNames).toContain('send zap');
    expect(sendActivity).toHaveBeenCalledWith('Hello from the assistant');
  });

  test('lists the commands instead of the generic error when the assistant fails', async () => {
    config.foundryProjectEndpoint = 'https://foundry.example';
    config.foundryModel = 'model-1';
    const failure = new Error('500 server_error');
    jest.mocked(runConversationalTurn).mockRejectedValueOnce(failure);
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({ text: 'Hi Zaplie!' });

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledTimes(1);
    const [guide] = sendActivity.mock.calls[0] as unknown as [string];
    expect(guide).not.toBe(GENERIC_ERROR_MESSAGE);
    expect(guide).toContain("I can't chat right now");
    expect(guide).toContain('send zap');
    expect(guide).toContain('show my balance');
    expect(guide).toContain('show leaderboard');
    expect(consoleError).toHaveBeenCalledWith(
      'The assistant failed; sending the command guide instead:',
      failure,
    );
  });

  test('starts a fresh assistant conversation after a failed turn', async () => {
    config.foundryProjectEndpoint = 'https://foundry.example';
    config.foundryModel = 'model-1';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest
      .mocked(runConversationalTurn)
      .mockResolvedValueOnce({
        replyText: 'Hello from the assistant',
        foundryConversationId: 'foundry-conv-1',
      })
      .mockRejectedValueOnce(new Error('500 server_error'))
      .mockResolvedValueOnce({
        replyText: 'Back again',
        foundryConversationId: 'foundry-conv-2',
      });
    const bot = new TeamsBot();

    for (const text of ['Hi Zaplie!', 'how are you?', 'still there?']) {
      await bot.run(makeContext({ text }).context);
    }

    const conversationIds = jest
      .mocked(runConversationalTurn)
      .mock.calls.map(call => call[1]);
    // The failed turn continued the first conversation; the turn after it
    // starts a new one instead of reusing a conversation that may be broken.
    expect(conversationIds).toEqual([undefined, 'foundry-conv-1', undefined]);
  });

  test.each([
    ['Hi Zaplie!', "Hi! I'm Zaplie."],
    ['what can you do?', "D'oh! I didn't recognize that command."],
  ])(
    'without the assistant, %j gets the guide that starts %j',
    async (text, opening) => {
      config.foundryProjectEndpoint = undefined;
      config.foundryModel = undefined;
      const bot = new TeamsBot();
      const { context, sendActivity } = makeContext({ text });

      await bot.run(context);

      const [guide] = sendActivity.mock.calls[0] as unknown as [string];
      expect(guide.startsWith(opening)).toBe(true);
    },
  );
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
    canReceive: true,
    allowanceWallet: null,
  };

  const submitContext = (cardId: string, zapAmount = '10'): MockContext => {
    const mock = makeContext({
      replyToId: cardId,
      value: {
        action: 'submitZaps',
        zapReceiverId: 'recipient-1',
        zapMessage: 'thanks!',
        zapAmount,
      },
    });
    (mock.context.turnState as Map<unknown, unknown>).set('user', {
      id: 'user-1',
      displayName: 'Alice',
      aadObjectId: 'aad-user-1',
      canReceive: false,
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
    jest.mocked(getPerson).mockResolvedValue(receiver);
    jest.mocked(getWalletBalance).mockResolvedValue(1000);
    jest
      .mocked(createInvoiceForPerson)
      .mockResolvedValue('lnbc1-payment-request');
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

  // Number('1e3') is 1000: a submit forged outside the card used to pay
  // 1,000 sats for an amount the card would never let through.
  test('a forged 1e3 amount sends nothing and gets the amount error', async () => {
    jest.mocked(getWalletBalance).mockResolvedValue(5000);
    const bot = new TeamsBot();
    const submit = submitContext('card-forged-amount', '1e3');

    await bot.run(submit.context);

    expect(submit.sendActivity).toHaveBeenCalledWith(
      "D'oh! You must specify a whole number between 1 and 10,000 Sats.",
    );
    expect(getPerson).not.toHaveBeenCalled();
    expect(createInvoiceForPerson).not.toHaveBeenCalled();
    expect(payInvoice).not.toHaveBeenCalled();
  });

  test('pays a different card to the same recipient normally', async () => {
    const bot = new TeamsBot();

    await bot.run(submitContext('card-a').context);
    await bot.run(submitContext('card-b').context);

    expect(payInvoice).toHaveBeenCalledTimes(2);
  });
});

describe('TeamsBot tells the recipient once a zap is paid', () => {
  const receiver: User = {
    id: 'recipient-1',
    displayName: 'Bob',
    profileImg: '',
    aadObjectId: 'aad-bob',
    email: 'bob@example.test',
    canReceive: true,
    allowanceWallet: null,
  };

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.mocked(getPerson).mockResolvedValue(receiver);
    jest.mocked(getWalletBalance).mockResolvedValue(1000);
    jest
      .mocked(createInvoiceForPerson)
      .mockResolvedValue('lnbc1-payment-request');
    jest.mocked(payInvoice).mockResolvedValue({ payment_hash: 'hash-1' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('opens the recipient chat by AAD object id and sends the line, after the receipt', async () => {
    const sent: { text?: string }[] = [];
    const proactive = {
      sendActivity: jest.fn(async (activity: { text?: string }) => {
        sent.push(activity);
        return undefined;
      }),
    } as unknown as TurnContext;
    const createConversationAsync = jest.fn(
      async (
        _botAppId: string,
        _channelId: string,
        _serviceUrl: string,
        _audience: string,
        _parameters: unknown,
        logic: (context: TurnContext) => Promise<void>,
      ) => {
        await logic(proactive);
      },
    );
    const mock = makeContext({
      replyToId: 'card-notify',
      serviceUrl: 'https://smba.trafficmanager.net/amer/tenant-1/',
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
      canReceive: false,
      allowanceWallet: {
        id: 'w-alice-allow',
        inkey: 'ink-alice-allow',
        adminkey: 'adm-alice-allow',
      },
    });
    Object.assign(mock.context, { adapter: { createConversationAsync } });

    const bot = new TeamsBot();
    await bot.run(mock.context);
    await bot.settleBackgroundWork();

    expect(payInvoice).toHaveBeenCalledTimes(1);
    expect(createConversationAsync).toHaveBeenCalledTimes(1);
    const [botAppId, channelId, serviceUrl, , parameters] =
      createConversationAsync.mock.calls[0];
    expect(botAppId).toBe('bot-app-id');
    expect(channelId).toBe('msteams');
    expect(serviceUrl).toBe('https://smba.trafficmanager.net/amer/tenant-1/');
    expect(parameters).toMatchObject({
      isGroup: false,
      tenantId: 'tenant-1',
      members: [{ id: 'aad-bob' }],
    });
    expect(sent.map(activity => activity.text)).toEqual([
      `⚡ Alice zapped you 10 ${process.env.LNBITS_POINTS_LABEL}: "thanks!"`,
    ]);
    // The receipt (updateActivity) and the confirmation line come first; the
    // recipient's chat is opened only after them.
    const receiptOrder = (mock.context.updateActivity as jest.Mock).mock
      .invocationCallOrder[0];
    expect(mock.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Awesome! You sent 10'),
    );
    expect(createConversationAsync.mock.invocationCallOrder[0]).toBeGreaterThan(
      receiptOrder,
    );
  });
});

// agent-pulse: a stand-in library, loaded through the wrapper's test hook
// (jest cannot run the real ES import), so the events can be asserted.
const mockPulseEmit = jest.fn();
const usePulseStandIn = (): void => {
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = 'InstrumentationKey=test';
  resetPulseForTests(async () => ({
    createPulse: () => ({
      emit: async (event: unknown) => {
        mockPulseEmit(event);
      },
      flush: async () => undefined,
    }),
    activityIdFrom: (id: string) => `sha256:${id}`,
  }));
};
const dropPulseStandIn = (): void => {
  delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  resetPulseForTests();
};

describe('TeamsBot records AgentActivity events', () => {
  const receiver: User = {
    id: 'recipient-1',
    displayName: 'Bob',
    profileImg: '',
    aadObjectId: 'aad-bob',
    email: 'bob@example.test',
    canReceive: true,
    allowanceWallet: null,
  };

  const submit = (cardId: string): MockContext => {
    const mock = makeContext({
      id: `msg-${cardId}`,
      replyToId: cardId,
      value: {
        action: 'submitZaps',
        zapReceiverId: 'recipient-1',
        zapMessage: 'thanks for the proposal!',
        zapAmount: '10',
      },
    });
    (mock.context.turnState as Map<unknown, unknown>).set('user', {
      id: 'user-1',
      displayName: 'Alice',
      aadObjectId: 'aad-user-1',
      canReceive: false,
      allowanceWallet: {
        id: 'w-alice-allow',
        inkey: 'ink-alice-allow',
        adminkey: 'adm-alice-allow',
      },
    });
    return mock;
  };

  const events = () =>
    mockPulseEmit.mock.calls.map(([event]) => event as Record<string, unknown>);

  beforeEach(() => {
    usePulseStandIn();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.mocked(getPerson).mockResolvedValue(receiver);
    jest.mocked(getWalletBalance).mockResolvedValue(1000);
    jest
      .mocked(createInvoiceForPerson)
      .mockResolvedValue('lnbc1-payment-request');
    jest.mocked(payInvoice).mockResolvedValue({ payment_hash: 'hash-1' });
  });

  afterEach(() => {
    dropPulseStandIn();
    mockPulseEmit.mockReset();
    jest.restoreAllMocks();
  });

  test('a paid zap records zap.sent with the sats and no names or message', async () => {
    await new TeamsBot().run(submit('card-pulse-paid').context);
    await pulseSettled();

    const sent = events().filter(e => e.activityType === 'zap.sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      level: 'success',
      channel: 'teams',
      measurements: { sats: 10 },
    });
    expect(sent[0].activityId).toEqual(expect.stringContaining('sha256:'));
    const serialised = JSON.stringify(events());
    for (const pii of ['Alice', 'Bob', 'thanks for the proposal']) {
      expect(serialised).not.toContain(pii);
    }
  });

  test('a zap that never reaches LNbits records zap.failed at level error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest
      .mocked(createInvoiceForPerson)
      .mockResolvedValue(null as unknown as string);

    await new TeamsBot().run(submit('card-pulse-failed').context);

    await pulseSettled();

    expect(events()).toContainEqual(
      expect.objectContaining({
        activityType: 'zap.failed',
        level: 'error',
        measurements: { sats: 10 },
      }),
    );
  });

  test('a duplicate submit records nothing new', async () => {
    const bot = new TeamsBot();
    await bot.run(submit('card-pulse-dup').context);
    await pulseSettled();
    mockPulseEmit.mockReset();

    await bot.run(submit('card-pulse-dup').context);

    await pulseSettled();

    expect(events()).toEqual([]);
  });

  test('a telemetry failure never affects the zap', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPulseEmit.mockImplementation(() => {
      throw new Error('telemetry down');
    });
    const mock = submit('card-pulse-throws');

    await new TeamsBot().run(mock.context);

    await pulseSettled();

    expect(payInvoice).toHaveBeenCalledTimes(1);
    expect(mock.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Awesome! You sent 10'),
    );
    expect(mock.sendActivity).not.toHaveBeenCalledWith(GENERIC_ERROR_MESSAGE);
  });

  test('a command records chat.answered with the command as its subject', async () => {
    // The bot registers its commands when constructed: replace one after.
    const bot = new TeamsBot();
    const spy = new SpyCommand();
    SSOCommandMap.register('show leaderboard', spy);
    const { context } = makeContext({
      id: 'msg-cmd',
      text: 'show leaderboard',
    });

    await bot.run(context);

    await pulseSettled();

    expect(spy.execute).toHaveBeenCalledTimes(1);
    expect(events()).toEqual([
      expect.objectContaining({
        activityType: 'chat.answered',
        title: 'Answered command · show-leaderboard',
        subject: 'show-leaderboard',
        activityId: 'sha256:msg-cmd',
      }),
    ]);
  });

  test('an unmatched channel message records chat.answered for the command guide', async () => {
    const { context } = makeContext({
      id: 'msg-guide',
      text: 'what can you do?',
      conversation: {
        id: 'conv-2',
        conversationType: 'channel',
        tenantId: 'tenant-1',
      },
    });

    await new TeamsBot().run(context);

    await pulseSettled();

    expect(events()).toEqual([
      expect.objectContaining({
        activityType: 'chat.answered',
        subject: 'command-guide',
      }),
    ]);
  });

  test('a failed assistant turn records chat.failed at level warning, not chat.answered', async () => {
    const saved = {
      endpoint: config.foundryProjectEndpoint,
      model: config.foundryModel,
    };
    config.foundryProjectEndpoint = 'https://foundry.example';
    config.foundryModel = 'model-1';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest
      .mocked(runConversationalTurn)
      .mockRejectedValueOnce(new Error('500 server_error'));
    const { context } = makeContext({ id: 'msg-assistant', text: 'hello' });

    try {
      await new TeamsBot().run(context);
      await pulseSettled();
    } finally {
      config.foundryProjectEndpoint = saved.endpoint;
      config.foundryModel = saved.model;
    }

    expect(events()).toEqual([
      expect.objectContaining({
        activityType: 'chat.failed',
        level: 'warning',
        subject: 'assistant-unavailable',
        channel: 'teams',
        activityId: 'sha256:msg-assistant',
      }),
    ]);
  });

  test('a failed message records chat.failed at level error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const mock = submit('card-pulse-nowallet');
    jest
      .mocked(getWalletBalance)
      .mockRejectedValueOnce(new Error('LNbits unavailable'));

    await new TeamsBot().run(mock.context);

    await pulseSettled();

    expect(events()).toEqual([
      expect.objectContaining({
        activityType: 'chat.failed',
        level: 'error',
        subject: 'internal',
      }),
    ]);
  });

  test('a card over the recipient cap is turned down, not failed, and records no zap', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const mock = submit('card-pulse-cap');
    (mock.context.activity.value as { zapReceiverId: string }).zapReceiverId =
      'r1,r2,r3,r4';

    await new TeamsBot().run(mock.context);

    await pulseSettled();

    expect(events()).toEqual([
      expect.objectContaining({
        activityType: 'chat.failed',
        level: 'warning',
        subject: 'user-facing',
      }),
    ]);
    expect(payInvoice).not.toHaveBeenCalled();
  });
});
