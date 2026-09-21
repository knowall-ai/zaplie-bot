// The synthetic event of a proactive send (createConversationAsync) carries no
// sender, so there is nobody to resolve and the lookups would only add failure
// modes to a notification. An ordinary message still resolves the sender.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { TeamsInfo } from 'botbuilder';
import type { TurnContext } from 'botbuilder';
import { FetchUserMiddleware } from './fetchUserMiddleware';
import { UserService } from './userService';

jest.mock('./lnbitsService');

const makeContext = (activity: Record<string, unknown>) =>
  ({
    activity,
    turnState: new Map<string, unknown>(),
  }) as unknown as TurnContext;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('FetchUserMiddleware on a proactive turn', () => {
  test('the createConversation event, which has no sender, skips the Teams and LNbits lookups', async () => {
    const getMember = jest
      .spyOn(TeamsInfo, 'getMember')
      .mockResolvedValue({ id: '29:bob' } as never);
    const ensureUserSetup = jest
      .spyOn(UserService.prototype, 'ensureUserSetup')
      .mockResolvedValue({ id: 'bob' } as never);
    const next = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    // What createConversationAsync builds: an event with a recipient and a
    // conversation, but no `from`.
    const context = makeContext({
      type: 'event',
      name: 'CreateConversation',
      recipient: { id: '28:bot', name: 'Zaplie' },
      conversation: { id: 'a:conv-bob', isGroup: false, tenantId: 'tenant-1' },
    });

    await new FetchUserMiddleware(UserService.getInstance()).onTurn(
      context,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(getMember).not.toHaveBeenCalled();
    expect(ensureUserSetup).not.toHaveBeenCalled();
    expect(context.turnState.get('user')).toBeUndefined();
  });

  test('a message still resolves the sender into the turn state', async () => {
    const member = { id: '29:alice', aadObjectId: 'aad-alice', name: 'Alice' };
    const user = { id: 'alice', aadObjectId: 'aad-alice' };
    const getMember = jest
      .spyOn(TeamsInfo, 'getMember')
      .mockResolvedValue(member as never);
    jest
      .spyOn(UserService.prototype, 'ensureUserSetup')
      .mockResolvedValue(user as never);
    const next = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const context = makeContext({
      type: 'message',
      from: { id: '29:alice', aadObjectId: 'aad-alice' },
    });

    await new FetchUserMiddleware(UserService.getInstance()).onTurn(
      context,
      next,
    );

    expect(getMember).toHaveBeenCalledWith(context, '29:alice');
    expect(context.turnState.get('user')).toBe(user);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
