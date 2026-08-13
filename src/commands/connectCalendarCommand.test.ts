import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { TurnContext } from 'botbuilder';
import {
  ConnectCalendarCommand,
  getStoredGraphToken,
} from './connectCalendarCommand';

describe('connectCalendarCommand', () => {
  const originalConnectionName = process.env.GRAPH_CONNECTION_NAME;

  const makeContext = (token?: string) => {
    const userTokenClientKey = Symbol('UserTokenClientKey');
    const userTokenClient = {
      getUserToken: jest
        .fn<() => Promise<any>>()
        .mockResolvedValue(token ? { token } : undefined),
      getSignInResource: jest.fn<() => Promise<any>>().mockResolvedValue({
        signInLink: 'https://login.example.test',
      }),
    };
    const turnState = new Map<unknown, unknown>();
    turnState.set(userTokenClientKey, userTokenClient);
    const context = {
      turnState,
      adapter: { UserTokenClientKey: userTokenClientKey },
      activity: {
        from: { id: 'teams-user' },
        channelId: 'msteams',
      },
      sendActivity: jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
    } as unknown as TurnContext;
    return { context, userTokenClient };
  };

  beforeEach(() => {
    process.env.GRAPH_CONNECTION_NAME = 'GraphWorkSignals';
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (originalConnectionName === undefined) {
      delete process.env.GRAPH_CONNECTION_NAME;
    } else {
      process.env.GRAPH_CONNECTION_NAME = originalConnectionName;
    }
  });

  test('retrieves the delegated token for the current Teams user', async () => {
    const { context, userTokenClient } = makeContext('graph-token');

    await expect(getStoredGraphToken(context, 'magic')).resolves.toBe(
      'graph-token',
    );
    expect(userTokenClient.getUserToken).toHaveBeenCalledWith(
      'teams-user',
      'GraphWorkSignals',
      'msteams',
      'magic',
    );
  });

  test('does not show another card when the user is already connected', async () => {
    const { context, userTokenClient } = makeContext('graph-token');

    await new ConnectCalendarCommand().execute(context);

    expect(userTokenClient.getSignInResource).not.toHaveBeenCalled();
    expect(context.sendActivity).toHaveBeenCalledWith(
      expect.stringMatching(/already connected/),
    );
  });

  test('posts an OAuth card when no delegated token is stored', async () => {
    const { context, userTokenClient } = makeContext();

    await new ConnectCalendarCommand().execute(context);

    expect(userTokenClient.getSignInResource).toHaveBeenCalled();
    expect(context.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: expect.any(Array) }),
    );
  });
});
