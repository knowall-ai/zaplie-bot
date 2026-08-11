// Per-recipient payment state for a zap card.
//
// Scope: this is in-memory, single-process state. It prevents a double click,
// a Teams retry or two concurrent submits from paying twice inside one running
// instance. It does NOT survive a restart and does not coordinate across
// instances, so it is best-effort protection rather than an at-most-once
// guarantee. A durable ledger is tracked in #187.

export type ZapEntryState = 'processing' | 'paid' | 'unknown';

export interface ZapEntry {
  state: ZapEntryState;
  paymentHash?: string;
  at: number;
}

export interface ZapKeyParts {
  tenantId: string | undefined;
  conversationId: string;
  cardId: string;
  recipientId: string;
}

export const zapKey = ({
  tenantId,
  conversationId,
  cardId,
  recipientId,
}: ZapKeyParts): string =>
  [tenantId ?? 'no-tenant', conversationId, cardId, recipientId].join('|');

export class ZapLedger {
  private entries = new Map<string, ZapEntry>();

  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  // Atomic in the single-threaded sense: the check and the write happen in one
  // synchronous block, so two concurrent submits cannot both acquire the slot.
  // Returns false when the recipient is already processing, paid, or unknown.
  tryAcquire(key: string): boolean {
    this.expire(key);
    if (this.entries.has(key)) {
      return false;
    }
    this.entries.set(key, { state: 'processing', at: Date.now() });
    return true;
  }

  markPaid(key: string, paymentHash: string): void {
    this.entries.set(key, { state: 'paid', paymentHash, at: Date.now() });
  }

  // A payment whose outcome could not be determined must not be retried
  // automatically: it may have settled. It stays until someone reconciles it.
  markUnknown(key: string): void {
    this.entries.set(key, { state: 'unknown', at: Date.now() });
  }

  // Only a recipient that never reached the payment call may be released.
  releaseIfProcessing(key: string): void {
    if (this.entries.get(key)?.state === 'processing') {
      this.entries.delete(key);
    }
  }

  get(key: string): ZapEntry | undefined {
    this.expire(key);
    return this.entries.get(key);
  }

  private expire(key: string): void {
    const entry = this.entries.get(key);
    // 'unknown' never expires on its own: it needs reconciliation, and dropping
    // it would silently re-enable a payment that may already have settled.
    if (entry && entry.state !== 'unknown' && Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
    }
  }
}
