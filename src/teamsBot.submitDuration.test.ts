// teamsBot.submitDuration.test.ts
//
// Teams ends a card submit's turn after 15 seconds and the recipients are paid
// one after another on it (issue 444). So one card pays at most
// ZAP_MAX_RECIPIENTS people, refused before the ledger and LNbits, and the
// recipient notifications run after the turn, not on it. Same harness as
// teamsBot.test.ts: the external services are mocked and the bot runs through
// its public run() entry point.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { TurnContext } from 'botbuilder';
import { GENERIC_ERROR_MESSAGE } from './messages';
import { getBalances, getPerson, payZap } from './services/peopleDirectory';

jest.mock('./services/peopleDirectory', () => {
  const actual = jest.requireActual<
    typeof import('./services/peopleDirectory')
  >('./services/peopleDirectory');
  return {
    ...actual,
    ensurePerson: jest.fn(),
    listPeople: jest.fn(),
    getPerson: jest.fn(),
    payZap: jest.fn(),
    payReward: jest.fn(),
    getBalances: jest.fn(),
    listZaps: jest.fn(),
  };
});
jest.mock('./services/foundryAgentService');
jest.mock('./services/graphService');
jest.mock('./services/zapHistoryService');

// teamsBot.ts refuses to load without the reward label, and the notifier reads
// BOT_ID through config, so both are set before the modules are required.
process.env.LNBITS_POINTS_LABEL = process.env.LNBITS_POINTS_LABEL || 'Sats';
process.env.BOT_ID = process.env.BOT_ID || 'bot-app-id';
// The durable zap ledger refuses to construct without a data directory. The
// path is per worker because sibling suites set and then delete this one.
process.env.ZAPLIE_DATA_DIR = path.join(
  os.tmpdir(),
  `zaplie-test-ledger-duration-${process.pid}`,
);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TeamsBot } = require('./teamsBot') as typeof import('./teamsBot');
// Tests spy on its export to stand in for a notifier bug.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const recipientNotifier = require('./services/recipientNotifier') as Record<
  'notifyZapRecipients',
  typeof import('./services/recipientNotifier').notifyZapRecipients
>;

const CAP_REFUSAL =
  "D'oh! You can zap up to 3 people from one card, and 4 were selected. No zaps were sent — pick 3 or fewer and try again.";

type MockContext = {
  context: TurnContext;
  sendActivity: jest.Mock;
};

const userFor = (id: string): User => ({
  id,
  displayName: `Person ${id}`,
  profileImg: '',
  aadObjectId: `aad-${id}`,
  email: `${id}@example.test`,
  canReceive: true,
  allowanceWallet: null,
});

// Each test uses its own card id: the ledger is shared across the file.
const submit = (
  cardId: string,
  zapReceiverId: string,
  createConversationAsync: jest.Mock = jest.fn(),
): MockContext => {
  const sendActivity = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const context = {
    activity: {
      type: 'message',
      channelId: 'msteams',
      serviceUrl: 'https://smba.trafficmanager.net/amer/tenant-1/',
      recipient: { id: 'bot-id' },
      from: { id: 'user-1' },
      conversation: {
        id: 'conv-1',
        conversationType: 'personal',
        tenantId: 'tenant-1',
      },
      replyToId: cardId,
      value: {
        action: 'submitZaps',
        zapReceiverId,
        zapMessage: 'thanks!',
        zapAmount: '10',
      },
    },
    turnState: new Map<unknown, unknown>([
      [
        'user',
        {
          id: 'user-1',
          displayName: 'Alice',
          aadObjectId: 'aad-user-1',
          canReceive: false,
          allowanceWallet: {
            id: 'w-alice-allow',
            inkey: 'ink-alice-allow',
            adminkey: 'adm-alice-allow',
          },
        },
      ],
    ]),
    sendActivity,
    updateActivity: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    adapter: { createConversationAsync },
  } as unknown as TurnContext;
  return { context, sendActivity };
};

const originalCap = process.env.ZAP_MAX_RECIPIENTS;

beforeEach(() => {
  delete process.env.ZAP_MAX_RECIPIENTS;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.mocked(getPerson).mockImplementation(async (id: string) => userFor(id));
  jest
    .mocked(getBalances)
    .mockResolvedValue({ allowanceSats: 1000, budgetRemainingSats: null });
  jest.mocked(payZap).mockResolvedValue('hash-1');
});

afterEach(() => {
  if (originalCap === undefined) {
    delete process.env.ZAP_MAX_RECIPIENTS;
  } else {
    process.env.ZAP_MAX_RECIPIENTS = originalCap;
  }
  jest.restoreAllMocks();
});

describe('TeamsBot caps the recipients of one zap card', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  test('a card over the default cap pays nobody and reads neither the ledger nor LNbits', async () => {
    const mock = submit('card-cap-over', 'r1,r2,r3,r4');

    await new TeamsBot().run(mock.context);

    expect(payZap).not.toHaveBeenCalled();
    expect(getPerson).not.toHaveBeenCalled();
    // The cap is checked before the live balance read.
    expect(getBalances).not.toHaveBeenCalled();
    expect(mock.context.updateActivity).not.toHaveBeenCalled();
    expect(mock.sendActivity).toHaveBeenCalledTimes(1);
    expect(mock.sendActivity).toHaveBeenCalledWith(CAP_REFUSAL);
  });

  test('resubmitting the same over-cap card gets the same refusal, not "already submitted"', async () => {
    const bot = new TeamsBot();
    const first = submit('card-cap-twice', 'r1,r2,r3,r4');
    const second = submit('card-cap-twice', 'r1,r2,r3,r4');

    await bot.run(first.context);
    await bot.run(second.context);

    expect(payZap).not.toHaveBeenCalled();
    expect(first.sendActivity).toHaveBeenCalledWith(CAP_REFUSAL);
    expect(second.sendActivity).toHaveBeenCalledWith(CAP_REFUSAL);
  });

  test('a card at the cap pays everyone', async () => {
    const bot = new TeamsBot();
    const mock = submit('card-cap-at', 'r1,r2,r3');

    await bot.run(mock.context);
    await bot.settleBackgroundWork();

    expect(payZap).toHaveBeenCalledTimes(3);
    expect(mock.context.updateActivity).toHaveBeenCalledTimes(1);
  });

  test('an operator override raises the cap', async () => {
    process.env.ZAP_MAX_RECIPIENTS = '4';
    const bot = new TeamsBot();
    const mock = submit('card-cap-override', 'r1,r2,r3,r4');

    await bot.run(mock.context);
    await bot.settleBackgroundWork();

    expect(payZap).toHaveBeenCalledTimes(4);
  });

  test('a malformed override stops the bot from starting', () => {
    process.env.ZAP_MAX_RECIPIENTS = '0';

    expect(() => new TeamsBot()).toThrow(/ZAP_MAX_RECIPIENTS/);
  });

  test('a self-zap among too many recipients is told the self-zap reason first', async () => {
    const mock = submit('card-cap-self', 'user-1,r2,r3,r4');

    await new TeamsBot().run(mock.context);

    expect(payZap).not.toHaveBeenCalled();
    expect(mock.sendActivity).toHaveBeenCalledWith(
      "D'oh! You cannot zap yourself, so no zaps were sent.",
    );
    expect(mock.sendActivity).not.toHaveBeenCalledWith(CAP_REFUSAL);
  });
});

// A notification can take NOTIFY_TIMEOUT_MS per recipient plus a 429 retry,
// so the turn must not wait for it. The first two tests moved here from
// teamsBot.test.ts with the change; they now settle the background work.
describe('TeamsBot sends recipient notifications off the turn', () => {
  test('a two-recipient zap tells both, after the receipt', async () => {
    const members: string[] = [];
    const createConversationAsync = jest.fn(
      async (
        _b: string,
        _c: string,
        _s: string,
        _a: string,
        parameters: unknown,
        logic: (context: TurnContext) => Promise<void>,
      ) => {
        members.push(
          (parameters as { members: { id: string }[] }).members[0].id,
        );
        await logic({
          sendActivity: jest.fn(async () => undefined),
        } as unknown as TurnContext);
      },
    );
    const mock = submit(
      'card-notify-two',
      'r1,r2',
      createConversationAsync as unknown as jest.Mock,
    );

    const bot = new TeamsBot();
    await bot.run(mock.context);
    await bot.settleBackgroundWork();

    expect(payZap).toHaveBeenCalledTimes(2);
    expect(members.sort()).toEqual(['aad-r1', 'aad-r2']);
    const receiptOrder = (mock.context.updateActivity as jest.Mock).mock
      .invocationCallOrder[0];
    for (const order of createConversationAsync.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(receiptOrder);
    }
    expect(mock.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Awesome! You sent 10'),
    );
  });

  test('a notifier failure leaves the sender with the receipt and the success line', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const createConversationAsync = jest.fn(async () => {
      throw Object.assign(new Error('Internal server error'), {
        statusCode: 500,
        code: 'ServiceError',
      });
    });
    const mock = submit(
      'card-notify-fails',
      'r1',
      createConversationAsync as unknown as jest.Mock,
    );

    const bot = new TeamsBot();
    await bot.run(mock.context);
    await bot.settleBackgroundWork();

    expect(payZap).toHaveBeenCalledTimes(1);
    expect(mock.context.updateActivity).toHaveBeenCalledTimes(1);
    expect(mock.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Awesome! You sent 10'),
    );
    expect(mock.sendActivity).not.toHaveBeenCalledWith(GENERIC_ERROR_MESSAGE);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(
        /aad-r1 could not be notified \(open, 500 ServiceError\)/,
      ),
      expect.any(Error),
    );
  });

  test('the turn ends without waiting for the recipient notifications', async () => {
    const members: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const createConversationAsync = jest.fn(
      async (
        _b: string,
        _c: string,
        _s: string,
        _a: string,
        parameters: unknown,
        logic: (context: TurnContext) => Promise<void>,
      ) => {
        await held;
        members.push(
          (parameters as { members: { id: string }[] }).members[0].id,
        );
        await logic({
          sendActivity: jest.fn(async () => undefined),
        } as unknown as TurnContext);
      },
    );
    const mock = submit(
      'card-turn-not-held',
      'r1,r2',
      createConversationAsync as unknown as jest.Mock,
    );
    const bot = new TeamsBot();

    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      bot.run(mock.context).then(() => 'turn'),
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve('timeout'), 1000);
      }),
    ]);
    clearTimeout(timer);
    release();

    expect(settled).toBe('turn');
    expect(mock.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Awesome! You sent 10'),
    );

    await bot.settleBackgroundWork();

    expect(members.sort()).toEqual(['aad-r1', 'aad-r2']);
    const receiptOrder = (mock.context.updateActivity as jest.Mock).mock
      .invocationCallOrder[0];
    for (const order of createConversationAsync.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(receiptOrder);
    }
  });

  test('a notifier that rejects never reaches the sender', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    jest
      .spyOn(recipientNotifier, 'notifyZapRecipients')
      .mockRejectedValueOnce(new Error('notifier bug'));
    const mock = submit('card-notifier-rejects', 'r1');
    const bot = new TeamsBot();

    await bot.run(mock.context);

    expect(mock.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Awesome! You sent 10'),
    );
    expect(mock.sendActivity).not.toHaveBeenCalledWith(GENERIC_ERROR_MESSAGE);

    await bot.settleBackgroundWork();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Recipient notifications failed after the turn'),
      expect.any(Error),
    );
  });
});
