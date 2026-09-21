// User-facing bot copy shared across handlers. The text itself lives in
// src/i18n (English and Spanish); this module keeps the helpers the handlers
// call and the error type that carries a message key instead of prose.

import { Locale, MessageKey, MessageParams, en, t } from './i18n';

// Sent whenever a turn fails unexpectedly. Raw error messages can leak
// internals (wallet ids, env names, stack details) into the chat, so the
// details go to the logs and the user gets this instead. The constant is the
// English rendering, kept for callers and tests that compare against it;
// handlers that know the user's language use genericErrorMessage.
export const GENERIC_ERROR_MESSAGE = en.genericError;

export const genericErrorMessage = (locale: Locale): string =>
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

  localized(locale: Locale): string {
    return t(locale, this.key, this.params);
  }
}

const commandBullets = (commandNames: string[]): string =>
  commandNames.map(name => `- **${name}**`).join('\n');

// Channel fallback when a message matches no command: keep the D'oh tone,
// but tell people what the bot actually understands.
export const unrecognizedCommandGuide = (
  commandNames: string[],
  locale: Locale = 'en',
): string =>
  t(locale, 'unrecognizedCommand', { commands: commandBullets(commandNames) });

// Sent once when the bot is installed or added to a conversation.
export const welcomeMessage = (
  commandNames: string[],
  locale: Locale = 'en',
): string => t(locale, 'welcome', { commands: commandBullets(commandNames) });
