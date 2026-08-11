// teamsBot.test.ts
import { expect, describe, test, beforeEach, afterAll, jest } from '@jest/globals';

const originalPointsLabel = process.env.LNBITS_POINTS_LABEL;
const originalAdminKey = process.env.LNBITS_ADMINKEY;
const originalDefaultSats = process.env.ZAP_MESSAGE_DEFAULT_SATS;

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

const { TeamsBot } = require('./teamsBot') as typeof import('./teamsBot');

const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;
const mockCreateZapCard = createZapCard as jest.MockedFunction<typeof createZapCard>;

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

function buildContext(user: User | undefined) {
  const turnState = new Map<string, unknown>();
  if (user) {
    turnState.set('user', user);
  }
  return {
    turnState,
    sendActivity: jest.fn(),
  } as unknown as import('botbuilder').TurnContext;
}

function buildAction(authorAadId: string | undefined, content = '<p>Great work!</p>') {
  return {
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
    delete process.env.ZAP_MESSAGE_DEFAULT_SATS;
    bot = new TeamsBot();
  });

  afterAll(() => {
    restoreEnv('LNBITS_POINTS_LABEL', originalPointsLabel);
    restoreEnv('LNBITS_ADMINKEY', originalAdminKey);
    restoreEnv('ZAP_MESSAGE_DEFAULT_SATS', originalDefaultSats);
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

    expect(mockCreateZapCard).toHaveBeenCalledWith(
      currentUser,
      'Sats',
      expect.objectContaining({ receiverId: authorUser.id, message: 'Great work!' }),
    );
    expect(mockGetUsers).toHaveBeenCalledWith('admin-key', {
      aadObjectId: authorUser.aadObjectId,
    });
    expect(context.sendActivity).toHaveBeenCalledTimes(1);
    expect(response).toEqual({});
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
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

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

  test('falls back to 1000 sats when the configured default is invalid', async () => {
    process.env.ZAP_MESSAGE_DEFAULT_SATS = 'not-a-positive-integer';
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const context = buildContext(currentUser);
    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(authorUser.aadObjectId),
    );

    expect(mockCreateZapCard).toHaveBeenCalledWith(
      currentUser,
      'Sats',
      expect.objectContaining({ amountSats: 1000 }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'ZAP_MESSAGE_DEFAULT_SATS must be a positive integer; using 1000.',
    );
    expect(response).toEqual({});
    warnSpy.mockRestore();
  });

  test('guards when the invoking user is not provisioned', async () => {
    const context = buildContext(undefined);
    const action = buildAction(authorUser.aadObjectId);

    const response = await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      action,
    );

    expect(mockGetUsers).not.toHaveBeenCalled();
    expect(mockCreateZapCard).not.toHaveBeenCalled();
    expect(context.sendActivity).toHaveBeenCalledWith(
      expect.stringContaining("couldn't find your Zaplie account"),
    );
    expect(response).toEqual({});
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
