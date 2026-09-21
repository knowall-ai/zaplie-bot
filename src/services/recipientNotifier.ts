// Tells a zap recipient, in their personal chat with the bot, that a zap to
// them has settled. The chat is opened on demand through the adapter's
// createConversationAsync, addressing the person by AAD object id with the
// tenant, service URL and bot identity of the sender's own turn: Teams
// returns the existing chat when there is one, so nothing is stored between
// turns and no Graph permission is involved. Runs after the ledger has
// recorded the payment and after the sender's receipt, and is best effort by
// contract: it returns an outcome and never throws, so nothing here can fail
// the sender's turn. Each attempt is bounded by a timeout, recipients are
// told a few at a time, and a throttled call is retried once.

import { MessageFactory, TextFormatTypes } from 'botbuilder';
import type {
  ChannelAccount,
  ConversationParameters,
  TurnContext,
} from 'botbuilder';
import config from '../config';
import { zapReceivedMessage } from '../messages';

export interface ZapNotification {
  recipient: { aadObjectId?: string; displayName?: string };
  senderName: string;
  amount: number;
  rewardName: string;
  message: string;
}

// 'unreachable': Teams would not open the chat for that person (the app is
// not installed for them, or the id is unknown to the tenant): expected, one
// warning. 'failed': anything else, from missing configuration to a timeout,
// a 401, a 5xx or a send refused once the chat was open: an error for the
// operator.
export type NotificationOutcome = 'notified' | 'unreachable' | 'failed';

// The OAuth scope for outbound calls to the Bot Framework channel service:
// AuthenticationConstants.ToChannelFromBotOAuthScope in botframework-connector,
// which is not a direct dependency of this package. Replies use the same one.
const BOT_FRAMEWORK_AUDIENCE = 'https://api.botframework.com';

// Per recipient, the whole open-and-send must finish within this or the
// attempt is reported as failed and the turn moves on. A stalled connector
// would otherwise hold the sender's turn until Azure redelivers the activity.
// The underlying call cannot be cancelled; it is left to finish or fail.
export const NOTIFY_TIMEOUT_MS = 5000;
// How many recipients are told at once: sequential puts every round trip on
// the sender's turn one after the other, unbounded invites throttling.
export const NOTIFY_CONCURRENCY = 3;
// A throttled call (429) is retried once after Teams' Retry-After, never
// longer than this; a missing or unreadable header waits one second.
export const RETRY_AFTER_CAP_MS = 5000;
const DEFAULT_RETRY_AFTER_MS = 1000;

// What Teams answers when the person cannot be addressed, by status and
// error code: 400 MemberNotFoundInConversation (unknown id) and 400 BadSyntax
// (an id that is not a user of the tenant), both observed in the trial
// tenant; 403 BotNotInConversationRoster (the app is not installed for them);
// 404 ConversationNotFound. The same status with another code is not about
// the recipient (malformed parameters, a tenant-wide block) and is an error.
const UNREACHABLE_CODES: Readonly<Record<number, ReadonlySet<string>>> = {
  400: new Set(['MemberNotFoundInConversation', 'BadSyntax']),
  403: new Set(['BotNotInConversationRoster']),
  404: new Set(['ConversationNotFound']),
};

interface ConnectorError {
  statusCode?: number;
  code?: string;
  message?: string;
  response?: { headers?: { get?: (name: string) => string | undefined } };
}

const connectorError = (error: unknown): ConnectorError =>
  typeof error === 'object' && error !== null
    ? (error as ConnectorError)
    : { message: String(error) };

const isUnreachable = (error: unknown): boolean => {
  const { statusCode, code } = connectorError(error);
  return (
    typeof statusCode === 'number' &&
    typeof code === 'string' &&
    (UNREACHABLE_CODES[statusCode]?.has(code) ?? false)
  );
};

const isThrottled = (error: unknown): boolean =>
  connectorError(error).statusCode === 429;

// Retry-After in its delta-seconds form; an HTTP-date value or a missing
// header falls back to the default.
const retryAfterMs = (error: unknown, capMs: number): number => {
  const raw = connectorError(error).response?.headers?.get?.('retry-after');
  const seconds = raw === undefined ? Number.NaN : Number(raw);
  const ms =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, capMs);
};

class NotificationTimeoutError extends Error {
  constructor(ms: number) {
    super(`The chat was not opened and written within ${ms} ms.`);
    this.name = 'NotificationTimeoutError';
  }
}

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NotificationTimeoutError(ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
};

const wait = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export interface RecipientNotifierDeps {
  botAppId?: string;
  timeoutMs?: number;
  retryAfterCapMs?: number;
  concurrency?: number;
}

export const notifyZapRecipient = async (
  context: TurnContext,
  notification: ZapNotification,
  deps: RecipientNotifierDeps = {},
): Promise<NotificationOutcome> => {
  const { recipient } = notification;
  const who = recipient.aadObjectId ?? recipient.displayName ?? '(unknown)';
  const timeoutMs = deps.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  const retryCapMs = deps.retryAfterCapMs ?? RETRY_AFTER_CAP_MS;
  // An object rather than a plain variable: the stage is set inside the
  // attempt closure, and control-flow narrowing would pin a `let` to 'prepare'.
  const progress: { stage: 'prepare' | 'open' | 'send' } = {
    stage: 'prepare',
  };
  try {
    if (!recipient.aadObjectId) {
      console.warn(
        `Zap recipient ${who} has no AAD object id on their LNbits account, so no notification was sent.`,
      );
      return 'unreachable';
    }
    const botAppId = deps.botAppId ?? config.botId;
    if (!botAppId) {
      throw new Error('BOT_ID is not set, so the bot cannot open a chat.');
    }
    const { activity } = context;
    // Teams stamps the tenant on the conversation for most activities and
    // only in channelData for some; read both rather than guess.
    const channelData = activity.channelData as
      { tenant?: { id?: string } } | undefined;
    const tenantId = activity.conversation?.tenantId ?? channelData?.tenant?.id;
    if (
      !tenantId ||
      !activity.serviceUrl ||
      !activity.channelId ||
      !activity.recipient?.id
    ) {
      throw new Error(
        'The turn carries no tenant, service URL, channel or bot identity to open a chat with.',
      );
    }
    const { channelId, serviceUrl } = activity;
    const parameters: ConversationParameters = {
      isGroup: false,
      bot: activity.recipient,
      // Teams addresses the member by id alone; the schema type also lists a
      // display name, which is not sent.
      members: [{ id: recipient.aadObjectId } as ChannelAccount],
      tenantId,
      channelData: { tenant: { id: tenantId } },
    };
    // Plain text: the zap message is the sender's own words, and markdown in
    // it must not restyle the line.
    const line = MessageFactory.text(zapReceivedMessage(notification));
    line.textFormat = TextFormatTypes.Plain;

    const attempt = async (): Promise<void> => {
      let ran = false;
      let delivery: unknown;
      progress.stage = 'open';
      await withTimeout(
        context.adapter.createConversationAsync(
          botAppId,
          channelId,
          serviceUrl,
          BOT_FRAMEWORK_AUDIENCE,
          parameters,
          async proactive => {
            ran = true;
            progress.stage = 'send';
            // Caught here on purpose: an error that leaves this callback goes
            // to the adapter's onTurnError, which would let the send report
            // as fine.
            try {
              await proactive.sendActivity(line);
            } catch (error) {
              delivery = error;
            }
          },
        ),
        timeoutMs,
      );
      if (!ran) {
        // The pipeline resolved without reaching the callback: a middleware
        // threw first and onTurnError swallowed it. Not a delivery.
        progress.stage = 'send';
        throw new Error(
          'The bot pipeline never reached the send: a middleware failed before the callback.',
        );
      }
      if (delivery !== undefined) {
        throw delivery;
      }
    };

    try {
      await attempt();
    } catch (error) {
      if (!isThrottled(error)) {
        throw error;
      }
      // One retry after Teams' own Retry-After; a second 429 is a failure.
      const pause = retryAfterMs(error, retryCapMs);
      console.warn(
        `Zap recipient ${who}: Teams throttled the ${progress.stage} (429); retrying once in ${pause} ms.`,
      );
      await wait(pause);
      await attempt();
    }
    return 'notified';
  } catch (error) {
    if (progress.stage === 'open' && isUnreachable(error)) {
      const { statusCode, code, message } = connectorError(error);
      console.warn(
        `Zap recipient ${who} cannot be addressed in Teams (is the app installed for them?), so no notification was sent; the zap is in their wallet. ${statusCode} ${code ?? ''}: ${message ?? ''}`,
      );
      return 'unreachable';
    }
    const { statusCode, code } = connectorError(error);
    console.error(
      `Zap recipient ${who} could not be notified (${progress.stage}${statusCode ? `, ${statusCode}` : ''}${code ? ` ${code}` : ''}); the payment stands.`,
      error,
    );
    return 'failed';
  }
};

// Tells every paid recipient of a submit, a few at a time. Outcomes come back
// in input order. Never throws: each recipient's outcome is its own.
export const notifyZapRecipients = async (
  context: TurnContext,
  notifications: ZapNotification[],
  deps: RecipientNotifierDeps = {},
): Promise<NotificationOutcome[]> => {
  const concurrency = Math.max(1, deps.concurrency ?? NOTIFY_CONCURRENCY);
  const outcomes: NotificationOutcome[] = new Array(notifications.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < notifications.length) {
      const index = next;
      next += 1;
      outcomes[index] = await notifyZapRecipient(
        context,
        notifications[index],
        deps,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, notifications.length) }, () =>
      worker(),
    ),
  );
  return outcomes;
};
