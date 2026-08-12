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
  getReceiver: () => Promise<ZapRecipient | null>;
  validateReceiver?: (receiver: ZapRecipient) => string | null;
  pay: (receiver: ZapRecipient) => Promise<{ paymentHash: string }>;
}

export interface ZapRecipient {
  id?: string;
  aadObjectId?: string;
  displayName?: string;
  privateWallet?: unknown;
}

export const validateSelfZap = (
  sender: Pick<ZapRecipient, 'id' | 'aadObjectId'>,
  receiver: Pick<ZapRecipient, 'id' | 'aadObjectId'>,
): string | null => {
  const sameUserId = Boolean(sender.id && receiver.id === sender.id);
  const sameAadObjectId = Boolean(
    sender.aadObjectId && receiver.aadObjectId === sender.aadObjectId,
  );
  return sameUserId || sameAadObjectId ? 'you cannot zap yourself' : null;
};

export const normalizeRecipientIds = (rawReceiverIds: unknown): string[] => {
  const submittedReceiverIds = Array.isArray(rawReceiverIds)
    ? rawReceiverIds
    : typeof rawReceiverIds === 'string'
      ? rawReceiverIds.split(',')
      : [];

  return Array.from(
    new Set(
      submittedReceiverIds
        .filter((id): id is string => typeof id === 'string')
        .map(id => id.trim())
        .filter(id => id.length > 0),
    ),
  );
};

export const getPendingRecipientIds = (
  ledger: ZapLedger,
  recipientIds: string[],
  entryKey: (recipientId: string) => string,
): string[] => recipientIds.filter(id => !ledger.get(entryKey(id)));

export const hasUnknownRecipientOutcome = (
  ledger: ZapLedger,
  recipientIds: string[],
  entryKey: (recipientId: string) => string,
): boolean =>
  recipientIds.some(id => ledger.get(entryKey(id))?.state === 'unknown');

// One recipient of a zap card. Extracted from the submitZaps loop so the
// ledger transitions are exercised by tests rather than re-implemented in them.
export async function processZapRecipient({
  ledger,
  entryKey,
  recipientId,
  getReceiver,
  validateReceiver,
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

  const validationError = validateReceiver?.(receiver);
  if (validationError) {
    ledger.releaseIfProcessing(entryKey);
    return { status: 'failed', label: `${label} (${validationError})` };
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
