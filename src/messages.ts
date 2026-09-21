// User-facing bot copy shared across handlers.

// Sent whenever a turn fails unexpectedly. Raw error messages can leak
// internals (wallet ids, env names, stack details) into the chat, so the
// details go to the logs and the user gets this instead.
export const GENERIC_ERROR_MESSAGE =
  "D'oh! Something went wrong on my end, so that didn't complete. Please try again in a moment.";

// Validation errors whose message is written for the user (balance, recipient
// checks). The onMessage catch relays these verbatim; everything else gets
// GENERIC_ERROR_MESSAGE.
export class UserFacingError extends Error {}

const commandBullets = (commandNames: string[]): string =>
  commandNames.map(name => `- **${name}**`).join('\n');

// Channel fallback when a message matches no command: keep the D'oh tone,
// but tell people what the bot actually understands.
export const unrecognizedCommandGuide = (commandNames: string[]): string =>
  "D'oh! I didn't recognize that command. Here's what I can help with:\n" +
  `${commandBullets(commandNames)}\n` +
  'Just type one of those to get started!';

// Sent once when the bot is installed or added to a conversation.
export const welcomeMessage = (commandNames: string[]): string =>
  "Hi, I'm Zaplie! I help you send zaps to your colleagues. " +
  'Here are the commands I understand:\n' +
  `${commandBullets(commandNames)}\n` +
  'Type one of those to get started!';

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
export const zapReceivedMessage = (zap: {
  senderName: string;
  amount: number;
  rewardName: string;
  message: string;
}): string =>
  `⚡ ${zap.senderName || 'A colleague'} zapped you ${zap.amount.toLocaleString()} ${zap.rewardName}: "${zapMemoPreview(zap.message)}"`;
