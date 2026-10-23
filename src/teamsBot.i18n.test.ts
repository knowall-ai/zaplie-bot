// teamsBot.i18n.test.ts
//
// The bot answers in the language of the Teams client (activity.locale):
// Spanish for any es-* tag, English for everything else, with numbers grouped
// for the client's region. Same harness as teamsBot.test.ts: the external
// services are mocked and the bot runs through its public run() entry point.

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
import { SSOCommandMap } from './commands/SSOCommandMap';
import { runConversationalTurn } from './services/foundryAgentService';
import {
  getUserWallets,
  getUsers,
  getWalletBalance,
  getWallets,
} from './services/lnbitsService';
import { en, es as esCopy } from './i18n';
import {
  DEFAULT_LEADERBOARD_WINDOW_DAYS,
  LEADERBOARD_PARTIAL_MESSAGE,
  LEADERBOARD_UNAVAILABLE_MESSAGE,
  leaderboardEmptyMessage,
  leaderboardTitle,
} from './commands/showLeaderboardCommand';
import { getZapLeaderboard } from './services/zapHistoryService';

jest.mock('./services/lnbitsService');
jest.mock('./services/foundryAgentService');
jest.mock('./services/graphService');
jest.mock('./services/zapHistoryService');

// teamsBot.ts refuses to load without the reward label, so it must be set
// before the module is required (which is why this is a require, not a
// hoisted import).
process.env.LNBITS_POINTS_LABEL = process.env.LNBITS_POINTS_LABEL || 'Sats';
process.env.BOT_ID = process.env.BOT_ID || 'bot-app-id';
// The durable zap ledger refuses to construct without a data directory. The
// path is per worker because sibling suites set and then delete this one.
process.env.ZAPLIE_DATA_DIR = path.join(
  os.tmpdir(),
  `zaplie-test-ledger-i18n-${process.pid}`,
);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TeamsBot } = require('./teamsBot') as typeof import('./teamsBot');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = (require('./config') as typeof import('./config')).default;

const makeContext = (activity: Record<string, unknown>) => {
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

// Every reply a Spanish client can trigger is Spanish (Ben's pre-merge point
// 2), and every number in it is written the way the client's region writes it
// (point 1). Command words, names, amounts and the reward label stay as data.
describe('TeamsBot answers a Spanish client in Spanish everywhere', () => {
  const originalEndpoint = config.foundryProjectEndpoint;
  const originalModel = config.foundryModel;

  const zapSubmitter = {
    id: 'user-1',
    aadObjectId: 'aad-user-1',
    displayName: 'Alice',
    allowanceWallet: { id: 'wallet-1', inkey: 'inkey', adminkey: 'adminkey' },
  };

  // English copy that differs from its Spanish rendering, cut at the
  // placeholders into fragments long enough to be unambiguous.
  const englishFragments = (): string[] => {
    const fragments = new Set<string>([
      leaderboardTitle(DEFAULT_LEADERBOARD_WINDOW_DAYS, 'Sats'),
      leaderboardTitle(1, 'Sats'),
      leaderboardEmptyMessage(DEFAULT_LEADERBOARD_WINDOW_DAYS),
      leaderboardEmptyMessage(1),
      LEADERBOARD_PARTIAL_MESSAGE,
      LEADERBOARD_UNAVAILABLE_MESSAGE,
      'View Wallets',
      'last day',
      'days):',
    ]);
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      if (en[key] === esCopy[key]) continue;
      for (const piece of en[key].split(/\{\{\w+\}\}|\n|\*\*/)) {
        if (piece.trim().length >= 10) fragments.add(piece.trim());
      }
    }
    return [...fragments];
  };

  const payloadText = (sendActivity: jest.Mock): string =>
    sendActivity.mock.calls
      .map(([payload]) =>
        typeof payload === 'string' ? payload : JSON.stringify(payload),
      )
      .join('\n');

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.mocked(getWalletBalance).mockResolvedValue(25_000);
    jest
      .mocked(getUsers)
      .mockResolvedValue([
        { id: 'user-2', displayName: 'Bob', aadObjectId: 'aad-2' } as never,
      ]);
    jest.mocked(getWallets).mockResolvedValue([
      {
        id: 'w-bob-priv',
        name: 'Private',
        user: 'user-2',
        balance_msat: 12_345_000,
      } as never,
    ]);
    jest
      .mocked(getUserWallets)
      .mockResolvedValue([
        { id: 'w-1', name: 'Allowance', balance_msat: 21_000_000 } as never,
      ]);
    // A ranked, partial read, so the leaderboard card's title, rows and
    // incomplete-read note are all swept, not just its error path.
    jest.mocked(getZapLeaderboard).mockResolvedValue({
      entries: [
        {
          user: { id: 'user-2', displayName: 'Bob' } as never,
          zappedSats: 12_345,
        },
      ],
      partial: true,
      skippedUsers: 0,
      skippedWallets: 1,
      truncated: false,
    });
  });

  afterEach(() => {
    config.foundryProjectEndpoint = originalEndpoint;
    config.foundryModel = originalModel;
    jest.restoreAllMocks();
  });

  test('no registered command answers an es-MX client with English copy', async () => {
    const fragments = englishFragments();
    const commandNames = SSOCommandMap.commandNames();
    expect(commandNames).toEqual(
      expect.arrayContaining([
        'send zap',
        'show my balance',
        'show leaderboard',
      ]),
    );

    for (const commandName of commandNames) {
      const bot = new TeamsBot();
      const { context, sendActivity } = makeContext({
        text: commandName,
        locale: 'es-MX',
      });
      (context.turnState as Map<unknown, unknown>).set('user', zapSubmitter);

      await bot.run(context);

      const text = payloadText(sendActivity);
      expect({ commandName, replied: text.length > 0 }).toEqual({
        commandName,
        replied: true,
      });
      for (const fragment of fragments) {
        expect({
          commandName,
          english: text.includes(fragment) && fragment,
        }).toEqual({ commandName, english: false });
      }
    }
  });

  test('show leaderboard sends an es-MX client the Spanish ranked card', async () => {
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      text: 'show leaderboard',
      locale: 'es-MX',
    });
    (context.turnState as Map<unknown, unknown>).set('user', zapSubmitter);

    await bot.run(context);

    const text = payloadText(sendActivity);
    expect(text).toContain(
      'Quienes más zapean (Sats enviados, últimos 7 días):',
    );
    expect(text).toContain('#1 Bob');
    expect(text).toContain('12,345 Sats');
    expect(text).toContain(
      'No se pudieron leer algunas carteras en este momento',
    );
  });

  test('an out-of-range amount names the ceiling in the es-ES format', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      replyToId: 'card-es-range',
      locale: 'es-ES',
      value: {
        action: 'submitZaps',
        zapReceiverId: 'recipient-9',
        zapMessage: 'gracias',
        zapAmount: '20000',
      },
    });
    (context.turnState as Map<unknown, unknown>).set('user', zapSubmitter);

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledWith(
      '¡Ups! Debes indicar un número entero entre 1 y 10.000 Sats.',
    );
  });

  test('a budget refusal groups the total and the balance for the region', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.mocked(getWalletBalance).mockResolvedValue(12_500);
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      replyToId: 'card-es-budget',
      locale: 'es-ES',
      value: {
        action: 'submitZaps',
        zapReceiverId: 'recipient-7,recipient-8',
        zapMessage: 'gracias',
        zapAmount: '9000',
      },
    });
    (context.turnState as Map<unknown, unknown>).set('user', zapSubmitter);

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledWith(
      '¡Ups! Eso enviaría 18.000 Sats entre 2 destinatario(s), pero tu saldo es 12.500. No se envió ningún zap.',
    );
  });

  test('greets a Spanish client in Spanish, including a Spanish greeting', async () => {
    config.foundryProjectEndpoint = undefined;
    config.foundryModel = undefined;

    for (const text of ['Hola', '¡Hola Zaplie!', 'buenos días', 'Hi Zaplie!']) {
      const bot = new TeamsBot();
      const { context, sendActivity } = makeContext({ text, locale: 'es-419' });

      await bot.run(context);

      const [guide] = sendActivity.mock.calls[0] as unknown as [string];
      expect({ text, guide }).toEqual({
        text,
        guide: expect.stringMatching(/^¡Hola! Soy Zaplie\./),
      });
      expect(guide).toContain('- **send zap**');
    }
  });

  test('offers the commands in Spanish when the assistant fails', async () => {
    config.foundryProjectEndpoint = 'https://foundry.example';
    config.foundryModel = 'model-1';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest
      .mocked(runConversationalTurn)
      .mockRejectedValueOnce(new Error('500 server_error'));
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      text: '¿qué puedes hacer?',
      locale: 'es-MX',
    });

    await bot.run(context);

    const [guide] = sendActivity.mock.calls[0] as unknown as [string];
    expect(guide).toMatch(/^Ahora mismo no puedo conversar/);
    expect(guide).toContain('- **show leaderboard**');
  });

  test('falls back to the Spanish no-reply line when the assistant says nothing', async () => {
    config.foundryProjectEndpoint = 'https://foundry.example';
    config.foundryModel = 'model-1';
    jest.mocked(runConversationalTurn).mockResolvedValueOnce({
      replyText: '',
      foundryConversationId: 'foundry-conv-es',
    });
    const bot = new TeamsBot();
    const { context, sendActivity } = makeContext({
      text: '¿cómo estás?',
      locale: 'es-ES',
    });

    await bot.run(context);

    expect(sendActivity).toHaveBeenCalledWith(
      '¡Ups! Lo siento, no reconocí ese comando. Pero tranquilo, cada vez aprendo más.',
    );
  });
});
