import { UserFacingError } from '../messages';

// Card inputs arrive as strings and the amount regex (built from the live
// balance when the card is created) is client-only and forgeable, so the
// amount and the cumulative budget must be enforced server-side before any
// payment. liveBalance must be a fresh read: the
// turn-state wallet snapshot never decrements across a multi-recipient loop.
//
// The errors carry message keys, not prose: the handler that catches them
// renders the text in the user's language.

export const MAX_ZAP_SATS = 10000;

export function validateZapSubmit(
  rawAmount: unknown,
  recipientCount: number,
  liveBalance: number,
  rewardName: string,
): number {
  const amount = Number(rawAmount);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_ZAP_SATS) {
    throw new UserFacingError('amountInvalid', {
      max: MAX_ZAP_SATS.toLocaleString(),
      rewardName,
    });
  }

  if (!Number.isInteger(recipientCount) || recipientCount < 1) {
    throw new UserFacingError('noRecipients');
  }

  // NaN passes `typeof x === 'number'` and every comparison against it is
  // false, so an unreadable balance would skip the budget check entirely.
  if (!Number.isFinite(liveBalance) || liveBalance < 0) {
    throw new UserFacingError('balanceUnreadable');
  }

  const totalRequired = amount * recipientCount;
  if (totalRequired > liveBalance) {
    throw new UserFacingError('budgetExceeded', {
      total: totalRequired,
      rewardName,
      count: recipientCount,
      balance: liveBalance,
    });
  }

  return amount;
}
