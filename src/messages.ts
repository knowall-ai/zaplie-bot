// User-facing bot copy shared across handlers. The text itself lives in
// src/i18n (English and Spanish); this module keeps the helpers the handlers
// call and the error type that carries a message key instead of prose.

import {
  LocaleTag,
  MessageKey,
  MessageParams,
  en,
  formatNumber,
  t,
} from './i18n';

// Sent whenever a turn fails unexpectedly. Raw error messages can leak
// internals (wallet ids, env names, stack details) into the chat, so the
// details go to the logs and the user gets this instead. The constant is the
// English rendering, kept for callers and tests that compare against it;
// handlers that know the user's language use genericErrorMessage.
export const GENERIC_ERROR_MESSAGE = en.genericError;

export const genericErrorMessage = (locale: LocaleTag): string =>
  t(locale, 'genericError');

// Validation errors written for the user (balance, recipient checks). They
// carry a message key so the onMessage catch can render them in the user's
// language; `message` stays the English rendering for logs and tests.
// Everything that is not a UserFacingError gets the generic message.
export class UserFacingError extends Error {
  constructor(
    public readonly key: MessageKey,
    public readonly params?: MessageParams,
  ) {
    super(t('en', key, params));
    this.name = 'UserFacingError';
  }

  localized(locale: LocaleTag): string {
    return t(locale, this.key, this.params);
  }
}

// The blank line after the list ends it: with a single newline, Teams
// renders the closing sentence as part of the last bullet.
const commandBullets = (commandNames: string[]): string =>
  `${commandNames.map(name => `- **${name}**`).join('\n')}\n\n`;

// Channel fallback when a message matches no command: keep the D'oh tone,
// but tell people what the bot actually understands.
export const unrecognizedCommandGuide = (
  commandNames: string[],
  locale: LocaleTag = 'en',
): string =>
  t(locale, 'unrecognizedCommand', { commands: commandBullets(commandNames) });

// "Hi", "Hello Zaplie!", "good morning", "¡Hola!", "buenos días": a
// greeting, not a failed command. The Spanish forms are here because the
// reply follows the client language, so a Spanish client greets in Spanish.
const GREETING =
  /^[¡\s]*(hi|hello|hey|hiya|howdy|morning|good (morning|afternoon|evening)|hola|buenas|buen(os)? d[ií]as?|buenas (tardes|noches))( there)?( zaplie)?[\s!.,👋]*$/iu;

export const isGreeting = (text: string): boolean => GREETING.test(text.trim());

// The fallback for a greeting: say hello back, then the same commands.
export const greetingGuide = (
  commandNames: string[],
  locale: LocaleTag = 'en',
): string => t(locale, 'greeting', { commands: commandBullets(commandNames) });

// The fallback when the conversational assistant fails (for example Azure AI
// Foundry returns a server error after the SDK's retries): the commands do
// not need the assistant, so offer them instead of a generic error.
export const assistantUnavailableGuide = (
  commandNames: string[],
  locale: LocaleTag = 'en',
): string =>
  t(locale, 'assistantUnavailable', { commands: commandBullets(commandNames) });

// Sent once when the bot is installed or added to a conversation.
export const welcomeMessage = (
  commandNames: string[],
  locale: LocaleTag = 'en',
): string => t(locale, 'welcome', { commands: commandBullets(commandNames) });

// The recipient sees the sender's words as one line of at most this many
// characters: the card's own length limit is client-side and forgeable, and
// a notice is not the place for an essay.
export const ZAP_MEMO_PREVIEW_MAX = 200;

// Whitespace runs (newlines included) become one space; anything past the
// limit is cut at a code point boundary and marked with an ellipsis.
export const zapMemoPreview = (message: string): string => {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  const chars = Array.from(oneLine);
  return chars.length > ZAP_MEMO_PREVIEW_MAX
    ? `${chars.slice(0, ZAP_MEMO_PREVIEW_MAX - 1).join('')}…`
    : oneLine;
};

// Sent to the recipient's personal chat once a zap to them has settled. The
// reward name comes from LNBITS_POINTS_LABEL, like every other amount line.
//
// Always English for now: the notice is a proactive message opened by AAD
// object id (recipientNotifier.ts), so there is no recipient activity and no
// reliable `activity.locale` to choose a language from. The copy has a key
// and Spanish text so it can follow the recipient once their language is
// known; until then both the words and the number format are English.
export const zapReceivedMessage = (zap: {
  senderName: string;
  amount: number;
  rewardName: string;
  message: string;
}): string =>
  t('en', 'zapReceived', {
    sender: zap.senderName || t('en', 'zapReceivedUnknownSender'),
    amount: formatNumber(zap.amount, 'en'),
    rewardName: zap.rewardName,
    message: zapMemoPreview(zap.message),
  });
