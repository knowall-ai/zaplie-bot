import { ZapLedger } from '../services/zapLedger';
import { PaymentOutcomeUnknownError } from './sendZapCommand';

export type RecipientOutcome =
  | { status: 'skipped' }
  | { status: 'paid'; label: string }
  | { status: 'failed'; label: string }
  | { status: 'needs-checking'; label: string };

export interface RecipientDeps {
  ledger: ZapLedger;
  entryKey: string;
  recipientId: string;
  // Typed as nullable on purpose: the LNbits lookup can legitimately miss.
  getReceiver: () => Promise<{ displayName?: string; privateWallet?: unknown } | null>;
  pay: (receiver: { displayName?: string }) => Promise<{ paymentHash: string }>;
}

// One recipient of a zap card. Extracted from the submitZaps loop so the
// ledger transitions are exercised by tests rather than re-implemented in them.
export async function processZapRecipient({
  ledger,
  entryKey,
  recipientId,
  getReceiver,
  pay,
}: RecipientDeps): Promise<RecipientOutcome> {
  if (ledger.get(entryKey) || !ledger.tryAcquire(entryKey)) {
    return { status: 'skipped' };
  }

  let receiver;
  try {
    receiver = await getReceiver();
  } catch (error) {
    // Nothing was paid, so the slot must be freed for a retry.
    ledger.releaseIfProcessing(entryKey);
    throw error;
  }

  const label = receiver?.displayName || `User ID: ${recipientId}`;

  if (!receiver?.privateWallet) {
    ledger.releaseIfProcessing(entryKey);
    return { status: 'failed', label };
  }

  let paid;
  try {
    paid = await pay(receiver);
  } catch (error) {
    if (error instanceof PaymentOutcomeUnknownError) {
      // The payment may already have settled, so a retry is unsafe.
      ledger.markUnknown(entryKey);
      console.error(`Zap to ${recipientId} ended in an unknown state.`, error);
      return { status: 'needs-checking', label };
    }
    // Failed before reaching LNbits: safe to retry.
    ledger.releaseIfProcessing(entryKey);
    console.error(`Zap to ${recipientId} failed before payment.`, error);
    return { status: 'failed', label };
  }

  // Recorded as soon as the hash is confirmed and before any card update, so a
  // UI failure cannot make a settled payment retryable.
  ledger.markPaid(entryKey, paid.paymentHash);
  return { status: 'paid', label };
}
