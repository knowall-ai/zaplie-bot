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
