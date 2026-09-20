// fetchUserMiddleware.test.ts
//
// The middleware runs on every turn the adapter processes, including the
// synthetic createConversation event that CloudAdapter.createConversationAsync
// pushes through the pipeline when the bot opens a 1:1 chat proactively.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import type { TurnContext } from 'botbuilder';
import { TeamsInfo } from 'botbuilder';
import { FetchUserMiddleware } from './fetchUserMiddleware';
import { UserService } from './userService';

const makeContext = (activity: Record<string, unknown>) =>
  ({
    activity,
    turnState: new Map<unknown, unknown>(),
  }) as unknown as TurnContext;

describe('FetchUserMiddleware', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('passes a turn with no sender straight through', async () => {
    // What createConversationAsync builds: an event activity with a recipient
    // and a conversation, but no `from`. Dereferencing from.id here threw
    // before the bot's own proactive callback could run, so the 1:1 zap card
    // was never delivered and every use of the action reported a failure.
    const getMember = jest.spyOn(TeamsInfo, 'getMember');
    const getInstance = jest.spyOn(UserService, 'getInstance');
    const next = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const context = makeContext({
      type: 'event',
      name: 'createConversation',
      channelId: 'msteams',
      recipient: { id: 'bot-id' },
      conversation: { id: 'a:1to1', isGroup: false, tenantId: 'tenant-1' },
    });

    await expect(
      new FetchUserMiddleware(UserService.getInstance()).onTurn(context, next),
    ).resolves.toBeUndefined();

    expect(next).toHaveBeenCalledTimes(1);
    expect(getMember).not.toHaveBeenCalled();
    expect(context.turnState.get('user')).toBeUndefined();

    getMember.mockRestore();
    getInstance.mockRestore();
  });

  test('resolves and stores the member on a normal turn', async () => {
    const member = { id: 'user-1', aadObjectId: 'aad-1' };
    const user = { id: 'lnbits-1', aadObjectId: 'aad-1' };
    const getMember = jest
      .spyOn(TeamsInfo, 'getMember')
      .mockResolvedValue(member as never);
    const ensureUserSetup = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(user);
    const getInstance = jest
      .spyOn(UserService, 'getInstance')
      .mockReturnValue({ ensureUserSetup } as unknown as UserService);
    const next = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const context = makeContext({
      type: 'message',
      channelId: 'msteams',
      from: { id: 'user-1' },
      conversation: { id: 'conv-1' },
    });

    await new FetchUserMiddleware(UserService.getInstance()).onTurn(
      context,
      next,
    );

    expect(ensureUserSetup).toHaveBeenCalledWith(member);
    expect(context.turnState.get('user')).toBe(user);
    expect(next).toHaveBeenCalledTimes(1);

    getMember.mockRestore();
    getInstance.mockRestore();
  });
});
