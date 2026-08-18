import { UserFacingError } from '../messages';

// Card inputs arrive as strings and the amount regex is client-only and
// forgeable, so the amount and the cumulative budget must be enforced
// server-side before any payment. liveBalance must be a fresh read: the
// turn-state wallet snapshot never decrements across a multi-recipient loop.

export const MAX_ZAP_SATS = 10000;

export function validateZapSubmit(
  rawAmount: unknown,
  recipientCount: number,
  liveBalance: number,
  rewardName: string,
): number {
  const amount = Number(rawAmount);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_ZAP_SATS) {
    throw new UserFacingError(
      `You must specify a whole number between 1 and ${MAX_ZAP_SATS.toLocaleString()} ${rewardName}.`,
    );
  }

  if (!Number.isInteger(recipientCount) || recipientCount < 1) {
    throw new UserFacingError(
      'No valid recipients were selected, so no zaps were sent.',
    );
  }

  // NaN passes `typeof x === 'number'` and every comparison against it is
  // false, so an unreadable balance would skip the budget check entirely.
  if (!Number.isFinite(liveBalance) || liveBalance < 0) {
    throw new UserFacingError(
      'Could not read your live balance, so no zaps were sent.',
    );
  }

  const totalRequired = amount * recipientCount;
  if (totalRequired > liveBalance) {
    throw new UserFacingError(
      `That would send ${totalRequired} ${rewardName} across ${recipientCount} ` +
        `recipient(s) but your balance is ${liveBalance}. No zaps were sent.`,
    );
  }

  return amount;
}
