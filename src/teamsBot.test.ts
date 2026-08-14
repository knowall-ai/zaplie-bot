// teamsBot.test.ts
import { expect, describe, test, beforeEach, jest } from '@jest/globals';

jest.mock('./services/lnbitsService');
jest.mock('./services/fetchRewardsName');
jest.mock('./commands/sendZapCommand', () => {
  const actual = jest.requireActual('./commands/sendZapCommand') as object;
  return {
    ...actual,
    createZapCard: jest.fn(),
  };
});

import { TeamsBot } from './teamsBot';
import { getUsers } from './services/lnbitsService';
import { getRewardName } from './services/fetchRewardsName';
import { createZapCard } from './commands/sendZapCommand';

const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;
const mockGetRewardName = getRewardName as jest.MockedFunction<typeof getRewardName>;
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
  let bot: TeamsBot;

  beforeEach(() => {
    jest.clearAllMocks();
    bot = new TeamsBot();
    mockGetRewardName.mockResolvedValue('Sats');
  });

  test('sends the zap card prefilled for the message author and returns {}', async () => {
    mockGetUsers.mockResolvedValue([currentUser, authorUser]);
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
    expect(context.sendActivity).toHaveBeenCalledTimes(1);
    expect(response).toEqual({});
  });

  test('reduces malformed message HTML to a safe plaintext memo', async () => {
    mockGetUsers.mockResolvedValue([authorUser]);
    mockCreateZapCard.mockResolvedValue({ type: 'AdaptiveCard' } as never);

    const context = buildContext(currentUser);
    await bot.handleTeamsMessagingExtensionSubmitAction(
      context,
      buildAction(
        authorUser.aadObjectId,
        'Great <<script>script>alert(1)</script> & <b>safe</b>',
      ),
    );

    const memo = mockCreateZapCard.mock.calls[0][2]?.message;
    expect(memo).not.toMatch(/[<>&]/);
    expect(memo).toContain('Great');
    expect(memo).toContain('safe');
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
    mockGetUsers.mockResolvedValue([currentUser]);

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
