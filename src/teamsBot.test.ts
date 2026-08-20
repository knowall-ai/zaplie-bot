// teamsBot.test.ts
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
  };
});

import { getUsers } from './services/lnbitsService';
import { createZapCard } from './commands/sendZapCommand';

// require, not import: imports hoist above the jest.mock calls above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TeamsBot } = require('./teamsBot') as typeof import('./teamsBot');

const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;
const mockCreateZapCard = createZapCard as jest.MockedFunction<
  typeof createZapCard
>;

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

function buildContext(user: User) {
  const turnState = new Map<string, unknown>();
  turnState.set('user', user);
  return {
    turnState,
    sendActivity: jest.fn(),
  } as unknown as import('botbuilder').TurnContext;
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
  } as unknown as import('botbuilder').MessagingExtensionAction;
}

describe('TeamsBot handleTeamsMessagingExtensionSubmitAction', () => {
  let bot: InstanceType<typeof TeamsBot>;

  beforeEach(() => {
    jest.clearAllMocks();
    bot = new TeamsBot();
  });

  afterAll(() => {
    restoreEnv('LNBITS_POINTS_LABEL', originalPointsLabel);
    restoreEnv('LNBITS_ADMINKEY', originalAdminKey);
  });

  test('sends the zap card prefilled for the message author and returns {}', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const context = buildContext(currentUser);
    const action = buildAction(authorUser.aadObjectId);

    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      action,
    );

    expect(mockCreateZapCard).toHaveBeenCalledWith(currentUser, 'Sats', {
      receiverId: authorUser.id,
      amountSats: 1000,
      message: 'Great work!',
    });
    expect(mockGetUsers).toHaveBeenCalledWith('admin-key', {
      aadObjectId: authorUser.aadObjectId,
    });
    expect(context.sendActivity).toHaveBeenCalledTimes(1);
    expect(response).toEqual({});
  });

  test('extracts a plain-text memo, decoding HTML entities', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const context = buildContext(currentUser);
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

  test('sends an empty memo when the message has no body content', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const context = buildContext(currentUser);
    const action = buildAction(authorUser.aadObjectId);
    delete (action as { messagePayload?: { body?: unknown } }).messagePayload!
      .body;

    await bot.handleTeamsMessagingExtensionSubmitAction(context, action);

    expect(mockCreateZapCard.mock.calls[0][2]?.message).toBe('');
  });

  test('caps the memo preview at 80 characters', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const context = buildContext(currentUser);
    await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId, `<p>${'x'.repeat(100)}</p>`),
    );

    expect(mockCreateZapCard.mock.calls[0][2]?.message).toBe('x'.repeat(80));
  });

  test('prefers a memo typed in the action dialog over the message text', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const context = buildContext(currentUser);
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

  test('guards against zapping yourself', async () => {
    mockGetUsers.mockResolvedValue([currentUser]);

    const context = buildContext(currentUser);
    const action = buildAction(currentUser.aadObjectId);

    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      action,
    );

    expect(mockCreateZapCard).not.toHaveBeenCalled();
    expect(context.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining("can't zap yourself"),
    );
    expect(response).toEqual({});
  });

  test('guards when the message author has no Zaplie account', async () => {
    mockGetUsers.mockResolvedValue([]);

    const context = buildContext(currentUser);
    const action = buildAction('aad-unknown-author');

    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      action,
    );

    expect(mockCreateZapCard).not.toHaveBeenCalled();
    expect(context.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining("doesn't have a Zaplie account"),
    );
    expect(response).toEqual({});
  });

  test('returns a friendly guard when the author lookup fails', async () => {
    mockGetUsers.mockRejectedValue(new Error('LNbits unavailable'));
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const context = buildContext(currentUser);
    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId),
    );

    expect(mockCreateZapCard).not.toHaveBeenCalled();
    expect(context.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining("couldn't check that teammate's Zaplie account"),
    );
    expect(response).toEqual({});
    errorSpy.mockRestore();
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
