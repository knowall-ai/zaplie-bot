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
    throw new Error(
      `You must specify a whole number between 1 and ${MAX_ZAP_SATS.toLocaleString()} ${rewardName}.`,
    );
  }

  const totalRequired = amount * recipientCount;
  if (totalRequired > liveBalance) {
    throw new Error(
      `That would send ${totalRequired} ${rewardName} across ${recipientCount} ` +
        `recipient(s) but your balance is ${liveBalance}. No zaps were sent.`,
    );
  }

  return amount;
}
