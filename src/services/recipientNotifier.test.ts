// The notifier runs after the payment: every path below must resolve to an
// outcome, and only the happy path may count as a delivery. The stand-in
// adapter mimics the real pipeline: it runs the callback and, like
// runMiddleware, routes an error that escapes it (or one thrown by a
// middleware before it) to onTurnError instead of rejecting, which is exactly
// the case the notifier must not mistake for a delivery.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import type { Activity, TurnContext } from 'botbuilder';
import {
  NOTIFY_CONCURRENCY,
  notifyZapRecipient,
  notifyZapRecipients,
} from './recipientNotifier';

jest.mock('../config', () => ({ __esModule: true, default: {} }));

const notification = {
  recipient: { aadObjectId: 'aad-bob', displayName: 'Bob' },
  senderName: 'Alice',
  amount: 21,
  rewardName: 'Sats',
  message: 'Thanks for the review!',
};

// The shape botframework-connector rejects with, optionally with the
// Retry-After header a 429 carries.
const restError = (
  statusCode: number,
  code: string,
  message: string,
  retryAfter?: string,
) =>
  Object.assign(new Error(message), {
    name: 'RestError',
    statusCode,
    code,
    response: {
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'retry-after' ? retryAfter : undefined,
      },
    },
  });

let sent: Partial<Activity>[];
const sendActivity = jest.fn(async (activity: Partial<Activity>) => {
  sent.push(activity);
  return undefined;
});
const proactive = { sendActivity } as unknown as TurnContext;
const onTurnError = jest.fn(
  async (_context: TurnContext, _error: unknown) => undefined,
);
// A middleware that throws before the callback, when set.
let middlewareFailure: Error | undefined;
// When set, the adapter never resolves: a stalled connector.
let hang = false;

const createConversationAsync = jest.fn(
  async (
    _botAppId: string,
    _channelId: string,
    _serviceUrl: string,
    _audience: string,
    _parameters: unknown,
    logic: (context: TurnContext) => Promise<void>,
  ) => {
    if (hang) {
      await new Promise<never>(() => undefined);
    }
    try {
      if (middlewareFailure) {
        throw middlewareFailure;
      }
      await logic(proactive);
    } catch (error) {
      await onTurnError(proactive, error);
    }
  },
);

const makeContext = (activity: Partial<Activity> = {}): TurnContext =>
  ({
    activity: {
      type: 'message',
      channelId: 'msteams',
      serviceUrl: 'https://smba.trafficmanager.net/amer/tenant-1/',
      recipient: { id: '28:bot', name: 'Zaplie' },
      from: { id: '29:alice', aadObjectId: 'aad-alice', name: 'Alice' },
      conversation: {
        id: 'a:conv-alice',
        conversationType: 'personal',
        tenantId: 'tenant-1',
      },
      ...activity,
    },
    adapter: { createConversationAsync },
  }) as unknown as TurnContext;

// Short waits so the timeout and Retry-After paths run in milliseconds.
const deps = { botAppId: 'bot-app-id', timeoutMs: 200, retryAfterCapMs: 20 };

beforeEach(() => {
  sent = [];
  middlewareFailure = undefined;
  hang = false;
  sendActivity.mockClear();
  createConversationAsync.mockClear();
  onTurnError.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('notifyZapRecipient', () => {
  test('opens the recipient chat by AAD object id and sends one plain-text line', async () => {
    const outcome = await notifyZapRecipient(makeContext(), notification, deps);

    expect(outcome).toBe('notified');
    expect(createConversationAsync).toHaveBeenCalledWith(
      'bot-app-id',
      'msteams',
      'https://smba.trafficmanager.net/amer/tenant-1/',
      'https://api.botframework.com',
      {
        isGroup: false,
        bot: { id: '28:bot', name: 'Zaplie' },
        members: [{ id: 'aad-bob' }],
        tenantId: 'tenant-1',
        channelData: { tenant: { id: 'tenant-1' } },
      },
      expect.any(Function),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(
      '⚡ Alice zapped you 21 Sats: "Thanks for the review!"',
    );
    expect(sent[0].textFormat).toBe('plain');
  });

  test('reads the tenant from channelData when the conversation carries none', async () => {
    const context = makeContext({
      conversation: {
        id: 'a:conv-alice',
        conversationType: 'personal',
      } as Activity['conversation'],
      channelData: { tenant: { id: 'tenant-2' } },
    });

    await expect(notifyZapRecipient(context, notification, deps)).resolves.toBe(
      'notified',
    );
    expect(createConversationAsync.mock.calls[0][4]).toMatchObject({
      tenantId: 'tenant-2',
    });
  });

  test('a recipient without an AAD object id is unreachable and nothing is opened', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const outcome = await notifyZapRecipient(
      makeContext(),
      { ...notification, recipient: { displayName: 'Bob' } },
      deps,
    );

    expect(outcome).toBe('unreachable');
    expect(createConversationAsync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Bob'));
  });

  test.each([
    [400, 'MemberNotFoundInConversation', 'Member not found in conversation.'],
    [400, 'BadSyntax', 'Invalid user identity in provided tenant'],
    [
      403,
      'BotNotInConversationRoster',
      'The bot is not part of the conversation roster.',
    ],
    [404, 'ConversationNotFound', 'Conversation not found.'],
  ])(
    'a person Teams cannot address (%i %s) is unreachable, logged as one warning, and nothing is sent',
    async (statusCode, code, message) => {
      createConversationAsync.mockRejectedValueOnce(
        restError(statusCode, code, message),
      );
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});

      const outcome = await notifyZapRecipient(
        makeContext(),
        notification,
        deps,
      );

      expect(outcome).toBe('unreachable');
      expect(sent).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`aad-bob.*${statusCode} ${code}: ${message}`),
        ),
      );
      expect(error).not.toHaveBeenCalled();
    },
  );

  test.each([
    [400, 'BadArgument', 'Invalid conversation parameters'],
    [403, 'Forbidden', 'Tenant blocked'],
    [401, 'Unauthorized', 'Authorization has been denied for this request.'],
    [500, 'ServiceError', 'Internal server error'],
  ])(
    'a refusal that is not about the recipient (%i %s) is a failure, logged as an error with its code',
    async (statusCode, code, message) => {
      createConversationAsync.mockRejectedValueOnce(
        restError(statusCode, code, message),
      );
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});

      const outcome = await notifyZapRecipient(
        makeContext(),
        notification,
        deps,
      );

      expect(outcome).toBe('failed');
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`aad-bob.*open, ${statusCode} ${code}`),
        ),
        expect.any(Error),
      );
    },
  );

  test('a send refused after the chat opened is a failure and never reaches onTurnError', async () => {
    sendActivity.mockRejectedValueOnce(
      restError(403, 'Forbidden', 'Forbidden'),
    );
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await notifyZapRecipient(makeContext(), notification, deps);

    expect(outcome).toBe('failed');
    expect(onTurnError).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/aad-bob.*send, 403/),
      expect.any(Error),
    );
  });

  test('a middleware failure before the callback is a failure, not a delivery', async () => {
    middlewareFailure = new TypeError(
      "Cannot read properties of undefined (reading 'id')",
    );
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await notifyZapRecipient(makeContext(), notification, deps);

    expect(outcome).toBe('failed');
    expect(sent).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('aad-bob'),
      expect.objectContaining({
        message: expect.stringContaining('never reached the send'),
      }),
    );
  });

  test('a connector that never answers is a failure within the timeout, and the turn moves on', async () => {
    hang = true;
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const started = Date.now();

    const outcome = await notifyZapRecipient(makeContext(), notification, {
      ...deps,
      timeoutMs: 50,
    });

    expect(outcome).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('aad-bob'),
      expect.objectContaining({
        name: 'NotificationTimeoutError',
        message: expect.stringContaining('within 50 ms'),
      }),
    );
  });

  test('a throttled open (429) waits for Retry-After, capped, and is retried once', async () => {
    createConversationAsync.mockRejectedValueOnce(
      restError(429, 'TooManyRequests', 'Too many requests', '30'),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();

    const outcome = await notifyZapRecipient(makeContext(), notification, deps);

    expect(outcome).toBe('notified');
    expect(createConversationAsync).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    // Retry-After said 30 s; the cap (20 ms in this test) won.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/aad-bob.*429.*retrying once in 20 ms/),
    );
  });

  test('a throttled send is retried once too, and a second 429 is a failure', async () => {
    sendActivity
      .mockRejectedValueOnce(restError(429, 'TooManyRequests', 'Slow down'))
      .mockRejectedValueOnce(restError(429, 'TooManyRequests', 'Slow down'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await notifyZapRecipient(makeContext(), notification, deps);

    expect(outcome).toBe('failed');
    expect(createConversationAsync).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/aad-bob.*send, 429 TooManyRequests/),
      expect.any(Error),
    );
  });

  test('a turn without a service URL or tenant is a failure, not a crash', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      notifyZapRecipient(
        makeContext({ serviceUrl: undefined }),
        notification,
        deps,
      ),
    ).resolves.toBe('failed');
    await expect(
      notifyZapRecipient(
        makeContext({
          conversation: { id: 'a:conv-alice' } as Activity['conversation'],
        }),
        notification,
        deps,
      ),
    ).resolves.toBe('failed');
    expect(createConversationAsync).not.toHaveBeenCalled();
  });

  test('a missing bot app id is a failure, not a crash', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      notifyZapRecipient(makeContext(), notification, { botAppId: '' }),
    ).resolves.toBe('failed');
    expect(createConversationAsync).not.toHaveBeenCalled();
  });
});

describe('notifyZapRecipients', () => {
  const recipients = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      ...notification,
      recipient: { aadObjectId: `aad-${i + 1}`, displayName: `R${i + 1}` },
    }));

  test('tells every recipient, a bounded number at a time, and reports in input order', async () => {
    let inFlight = 0;
    let peak = 0;
    createConversationAsync.mockImplementation(
      async (
        _b,
        _c,
        _s,
        _a,
        _p,
        logic: (context: TurnContext) => Promise<void>,
      ) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        await logic(proactive);
        inFlight -= 1;
      },
    );

    const outcomes = await notifyZapRecipients(
      makeContext(),
      recipients(7),
      deps,
    );

    expect(outcomes).toEqual(Array(7).fill('notified'));
    expect(createConversationAsync).toHaveBeenCalledTimes(7);
    expect(peak).toBe(NOTIFY_CONCURRENCY);
    expect(sent).toHaveLength(7);
  });

  test('one recipient failing does not stop the others', async () => {
    createConversationAsync.mockImplementation(
      async (
        _b,
        _c,
        _s,
        _a,
        parameters,
        logic: (context: TurnContext) => Promise<void>,
      ) => {
        const member = (parameters as { members: { id: string }[] }).members[0]
          .id;
        if (member === 'aad-2') {
          throw restError(
            400,
            'BadSyntax',
            'Invalid user identity in provided tenant',
          );
        }
        await logic(proactive);
      },
    );
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const outcomes = await notifyZapRecipients(
      makeContext(),
      recipients(3),
      deps,
    );

    expect(outcomes).toEqual(['notified', 'unreachable', 'notified']);
    expect(sent).toHaveLength(2);
  });

  test('no recipients is a no-op', async () => {
    await expect(notifyZapRecipients(makeContext(), [], deps)).resolves.toEqual(
      [],
    );
    expect(createConversationAsync).not.toHaveBeenCalled();
  });
});
