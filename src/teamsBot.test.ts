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
import { MessagingExtensionAction, TurnContext } from 'botbuilder';
import { GENERIC_ERROR_MESSAGE } from './messages';
import { SSOCommand, SSOCommandMap } from './commands/SSOCommandMap';
import {
  createInvoice,
  getUser,
  getUsers,
  getWalletBalance,
  payInvoice,
} from './services/lnbitsService';
import { createZapCard } from './commands/sendZapCommand';

jest.mock('./services/lnbitsService');
// Partial mock: the zap-message action asserts the card prefill, while the
// submitZaps suites below still run the real SendZap against the mocked
// LNbits boundary.
jest.mock('./commands/sendZapCommand', () => ({
  ...(jest.requireActual('./commands/sendZapCommand') as object),
  createZapCard: jest.fn(),
}));
jest.mock('./services/foundryAgentService');
jest.mock('./services/graphService');
jest.mock('./services/zapHistoryService');

// teamsBot.ts refuses to load without the reward label, so it must be set
// before the module is required (which is why this is a require, not a
// hoisted import).
process.env.LNBITS_POINTS_LABEL = process.env.LNBITS_POINTS_LABEL || 'Sats';
// teamsBot.ts also captures the LNbits admin key at module load; the
// zap-message suite asserts the author lookup is made with it.
process.env.LNBITS_ADMINKEY = process.env.LNBITS_ADMINKEY || 'admin-key';
// The zap-message action opens a 1:1 chat proactively, which needs the bot's
// app id; config.ts captures it at module load.
process.env.BOT_ID = process.env.BOT_ID || 'bot-app-id';
const rewardName = process.env.LNBITS_POINTS_LABEL;
const adminKey = process.env.LNBITS_ADMINKEY;
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

const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;
const mockCreateZapCard = createZapCard as jest.MockedFunction<
  typeof createZapCard
>;

// "Zap a message": the right-click action pays nothing. It opens the existing
// zap card, pre-filled, in the invoker's 1:1 chat with the bot - never in the
// conversation the message came from - and the card still goes through the
// submitZaps handler above, with its ledger lock and budget checks.
const currentUser = {
  id: 'currentUserId',
  displayName: 'Current User',
  profileImg: '',
  aadObjectId: 'aad-current',
  email: 'current@test.com',
  privateWallet: null,
  allowanceWallet: null,
} as User;

const authorUser = {
  id: 'authorUserId',
  displayName: 'Author User',
  profileImg: '',
  aadObjectId: 'aad-author',
  email: 'author@test.com',
  privateWallet: null,
  allowanceWallet: null,
} as User;

type ExtensionContext = {
  context: TurnContext;
  sendActivity: jest.Mock;
  createConversationAsync: jest.Mock;
  // Every activity the bot sent through the proactive 1:1 conversation.
  proactive: unknown[];
};

function buildContext(user: User | undefined): ExtensionContext {
  const turnState = new Map<string, unknown>();
  if (user) turnState.set('user', user);
  const sendActivity = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const proactive: unknown[] = [];
  // Stands in for CloudAdapter.createConversationAsync: runs the callback
  // against a throwaway 1:1 turn context and records what was sent there.
  const createConversationAsync = jest.fn(
    async (..._args: unknown[]): Promise<void> => {
      const logic = _args[5] as (c: TurnContext) => Promise<void>;
      await logic({
        sendActivity: async (activity: unknown) => {
          proactive.push(activity);
        },
      } as unknown as TurnContext);
    },
  );
  const context = {
    activity: {
      type: 'invoke',
      name: 'composeExtension/submitAction',
      channelId: 'msteams',
      serviceUrl: 'https://smba.example/teams/',
      recipient: { id: 'bot-id' },
      from: { id: 'invoker-teams-id' },
      conversation: { id: 'channel-thread-1', tenantId: 'tenant-1' },
    },
    turnState,
    sendActivity,
    adapter: { createConversationAsync },
  } as unknown as TurnContext;
  return {
    context,
    sendActivity: sendActivity as unknown as jest.Mock,
    createConversationAsync: createConversationAsync as unknown as jest.Mock,
    proactive,
  };
}

function buildAction(
  authorAadId: string | undefined,
  content = '<p>Great work!</p>',
  data?: Record<string, unknown>,
) {
  return {
    data,
    messagePayload: {
      from: {
        user: {
          id: authorAadId,
          displayName: 'Author User',
        },
      },
      body: {
        content,
      },
    },
  } as unknown as MessagingExtensionAction;
}

// A message posted by an app rather than a person: Teams sets `application`
// and leaves `user` unset.
function buildAppAuthoredAction() {
  return {
    messagePayload: {
      from: { application: { id: 'app-1', displayName: 'Some App' } },
      body: { content: '<p>Build 42 succeeded</p>' },
    },
  } as unknown as MessagingExtensionAction;
}

// Every reply goes back as a task-module message, which Teams shows only to
// the person who used the action.
const dialogText = (response: { task?: { value?: unknown } }): string =>
  String(response.task?.value ?? '');

describe('TeamsBot handleTeamsMessagingExtensionSubmitAction', () => {
  let bot: InstanceType<typeof TeamsBot>;

  beforeEach(() => {
    jest.clearAllMocks();
    bot = new TeamsBot();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('opens the prefilled card in the invoker 1:1 chat, never in the source conversation', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const { context, sendActivity, createConversationAsync, proactive } =
      buildContext(currentUser);
    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId),
    );

    expect(mockCreateZapCard).toHaveBeenCalledWith(currentUser, rewardName, {
      receiverId: authorUser.id,
      receiverName: authorUser.displayName,
      amountSats: 1000,
      message: 'Great work!',
    });
    expect(mockGetUsers).toHaveBeenCalledWith(adminKey, {
      aadObjectId: authorUser.aadObjectId,
    });

    // The card carries the invoker's own balance and a live Send Zap button,
    // and the ledger key is not scoped by sender - so it must never be posted
    // into the channel or group chat the message came from.
    expect(sendActivity).not.toHaveBeenCalled();
    expect(createConversationAsync).toHaveBeenCalledTimes(1);
    expect(proactive).toHaveLength(1);

    const [botAppId, channelId, serviceUrl, , parameters] =
      createConversationAsync.mock.calls[0] as [
        string,
        string,
        string,
        string,
        { isGroup: boolean; members: { id: string }[]; tenantId: string },
      ];
    expect(botAppId).toBe(process.env.BOT_ID);
    expect(channelId).toBe('msteams');
    expect(serviceUrl).toBe('https://smba.example/teams/');
    expect(parameters.isGroup).toBe(false);
    expect(parameters.members).toEqual([{ id: 'invoker-teams-id' }]);
    expect(parameters.tenantId).toBe('tenant-1');

    expect(response.task?.type).toBe('message');
    expect(dialogText(response)).toContain('Author User');
  });

  test('extracts a plain-text memo, decoding HTML entities', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const { context } = buildContext(currentUser);
    await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(
        authorUser.aadObjectId,
        '<p>that&#39;s great &amp;&nbsp;fast &#x2764; &lt;b&gt; &copy;</p>',
      ),
    );

    // Unsupported entities (&copy;) stay literal rather than decoding wrongly.
    expect(mockCreateZapCard.mock.calls[0][2]?.message).toBe(
      "that's great & fast ❤ <b> &copy;",
    );
  });

  test('strips markdown link syntax from the memo preview', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    // The memo is another person's message text and it is rendered back on
    // the zap receipt, whose TextBlock renders markdown: a link must not
    // survive as a live link.
    const { context } = buildContext(currentUser);
    await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(
        authorUser.aadObjectId,
        '<p>see [our invoice portal](https://evil.example) now</p>',
      ),
    );

    const memo = mockCreateZapCard.mock.calls[0][2]?.message ?? '';
    expect(memo).toBe('see our invoice portal now');
    expect(memo).not.toContain('evil.example');
    expect(memo).not.toContain('[');
  });

  test('sends an empty memo when the message has no body content', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const { context } = buildContext(currentUser);
    const action = buildAction(authorUser.aadObjectId);
    delete (action as { messagePayload?: { body?: unknown } }).messagePayload!
      .body;

    await bot.handleTeamsMessagingExtensionSubmitAction(context, action);

    expect(mockCreateZapCard.mock.calls[0][2]?.message).toBe('');
  });

  test('caps the memo preview at 80 characters', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const { context } = buildContext(currentUser);
    await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId, `<p>${'x'.repeat(100)}</p>`),
    );

    expect(mockCreateZapCard.mock.calls[0][2]?.message).toBe('x'.repeat(80));
  });

  test('caps a memo typed in the action dialog at the same 80 characters', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const { context } = buildContext(currentUser);
    await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId, '<p>Great work!</p>', {
        memo: 'y'.repeat(120),
      }),
    );

    // Nothing in the manifest bounds the dialog field, so the handler has to.
    expect(mockCreateZapCard.mock.calls[0][2]?.message).toBe('y'.repeat(80));
  });

  test('never splits a surrogate pair when capping the memo', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    // 79 plain characters then an astral emoji: the 80th code point is two
    // UTF-16 code units, so a naive slice(0, 80) would keep half of it.
    const { context } = buildContext(currentUser);
    await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId, `<p>${'z'.repeat(79)}\u{1f600}x</p>`),
    );

    const memo = mockCreateZapCard.mock.calls[0][2]?.message ?? '';
    expect(memo).toBe(`${'z'.repeat(79)}\u{1f600}`);
    expect(Array.from(memo)).toHaveLength(80);
    // The naive slice would have ended on the emoji's high surrogate alone.
    expect(memo).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  test('prefers a memo typed in the action dialog over the message text', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const { context } = buildContext(currentUser);
    await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId, '<p>Great work!</p>', {
        memo: '  Deploy fix appreciated  ',
      }),
    );

    expect(mockCreateZapCard.mock.calls[0][2]?.message).toBe(
      'Deploy fix appreciated',
    );
  });

  test('explains itself when the message was posted by an app, not a person', async () => {
    const { context, sendActivity, createConversationAsync } =
      buildContext(currentUser);
    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAppAuthoredAction(),
    );

    expect(mockGetUsers).not.toHaveBeenCalled();
    expect(mockCreateZapCard).not.toHaveBeenCalled();
    expect(createConversationAsync).not.toHaveBeenCalled();
    expect(sendActivity).not.toHaveBeenCalled();
    expect(dialogText(response)).toContain('posted by an app');
  });

  test('guards when the message author cannot be identified', async () => {
    const { context, createConversationAsync } = buildContext(currentUser);
    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(undefined),
    );

    expect(mockGetUsers).not.toHaveBeenCalled();
    expect(mockCreateZapCard).not.toHaveBeenCalled();
    expect(createConversationAsync).not.toHaveBeenCalled();
    expect(dialogText(response)).toContain(
      "couldn't tell who sent that message",
    );
  });

  test('guards when the invoker has no resolved Zaplie identity', async () => {
    const { context, createConversationAsync } = buildContext(undefined);
    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId),
    );

    expect(mockCreateZapCard).not.toHaveBeenCalled();
    expect(createConversationAsync).not.toHaveBeenCalled();
    expect(dialogText(response)).toContain("couldn't verify who you are");
  });

  test('guards against zapping yourself', async () => {
    mockGetUsers.mockResolvedValue([currentUser]);

    const { context, sendActivity, createConversationAsync } =
      buildContext(currentUser);
    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(currentUser.aadObjectId),
    );

    expect(mockCreateZapCard).not.toHaveBeenCalled();
    expect(createConversationAsync).not.toHaveBeenCalled();
    expect(sendActivity).not.toHaveBeenCalled();
    expect(dialogText(response)).toContain("can't zap yourself");
  });

  test('guards when the message author has no Zaplie account', async () => {
    mockGetUsers.mockResolvedValue([]);

    const { context, createConversationAsync } = buildContext(currentUser);
    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction('aad-unknown-author'),
    );

    expect(mockCreateZapCard).not.toHaveBeenCalled();
    expect(createConversationAsync).not.toHaveBeenCalled();
    expect(dialogText(response)).toContain("doesn't have a Zaplie account");
  });

  test('returns a friendly guard when the author lookup fails', async () => {
    mockGetUsers.mockRejectedValue(new Error('LNbits unavailable'));
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const { context, createConversationAsync } = buildContext(currentUser);
    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId),
    );

    expect(mockCreateZapCard).not.toHaveBeenCalled();
    expect(createConversationAsync).not.toHaveBeenCalled();
    expect(dialogText(response)).toContain(
      "couldn't check that teammate's Zaplie account",
    );
    errorSpy.mockRestore();
  });

  test('returns a friendly guard when building the card fails', async () => {
    // createZapCard reads the wallet list and the live balance, so LNbits
    // being down must land like the guards above rather than as a bare
    // task-module error.
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockRejectedValue(new Error('LNbits unavailable'));
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const { context, sendActivity, createConversationAsync } =
      buildContext(currentUser);
    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId),
    );

    expect(createConversationAsync).not.toHaveBeenCalled();
    expect(sendActivity).not.toHaveBeenCalled();
    expect(dialogText(response)).toContain("couldn't open a zap card");
    errorSpy.mockRestore();
  });

  test('returns a friendly guard when the 1:1 chat cannot be opened', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const { context, sendActivity, createConversationAsync } =
      buildContext(currentUser);
    createConversationAsync.mockImplementation(() =>
      Promise.reject(new Error('bot is not part of the conversation roster')),
    );

    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId),
    );

    // The failure must not fall back to posting the card in the channel.
    expect(sendActivity).not.toHaveBeenCalled();
    expect(dialogText(response)).toContain("couldn't open a zap card");
    errorSpy.mockRestore();
  });
});
