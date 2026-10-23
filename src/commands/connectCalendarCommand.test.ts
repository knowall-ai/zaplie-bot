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
        .fn<() => Promise<{ token: string } | undefined>>()
        .mockResolvedValue(token ? { token } : undefined),
      getSignInResource: jest
        .fn<() => Promise<{ signInLink: string }>>()
        .mockResolvedValue({
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
      sendActivity: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
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

  test('answers a Spanish client in Spanish when already connected', async () => {
    const { context } = makeContext('graph-token');
    (context.activity as { locale?: string }).locale = 'es-MX';

    await new ConnectCalendarCommand().execute(context);

    expect(context.sendActivity).toHaveBeenCalledWith(
      'Tu calendario ya está conectado. ¡Pregúntame por tus reuniones recientes!',
    );
  });

  test('builds the sign-in card in Spanish for a Spanish client', async () => {
    const { context } = makeContext();
    (context.activity as { locale?: string }).locale = 'es-ES';

    await new ConnectCalendarCommand().execute(context);

    const [message] = jest.mocked(context.sendActivity).mock
      .calls[0] as unknown as [{ attachments: { content: unknown }[] }];
    const card = JSON.stringify(message.attachments[0].content);
    expect(card).toContain('Conectar señales de trabajo');
    expect(card).toContain('acceso delegado y de solo lectura');
    expect(card).not.toContain('Connect work signals');
  });
});
