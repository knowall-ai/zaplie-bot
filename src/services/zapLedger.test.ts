import { expect, describe, test } from '@jest/globals';
import { ZapLedger, zapKey } from './zapLedger';

const key = (recipientId: string, overrides: Partial<Parameters<typeof zapKey>[0]> = {}) =>
  zapKey({
    tenantId: 'tenant-1',
    conversationId: 'conv-1',
    cardId: 'card-1',
    recipientId,
    ...overrides,
  });

// These cover the ledger in isolation. The payment flow that drives it is
// covered in teamsBot.zapFlow.test.ts.
describe('ZapLedger', () => {
  test('only the first acquire of a recipient slot succeeds', () => {
    const ledger = new ZapLedger();
    const first = ledger.tryAcquire(key('alice'));
    const second = ledger.tryAcquire(key('alice'));

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test('a paid slot stays locked while a released one can be acquired again', () => {
    const ledger = new ZapLedger();
    // First attempt: alice is paid, bob fails before the payment call.
    ledger.tryAcquire(key('alice'));
    ledger.markPaid(key('alice'), 'hash-alice');
    ledger.tryAcquire(key('bob'));
    ledger.releaseIfProcessing(key('bob'));

    // Retry: alice is locked, bob is free to be attempted again.
    expect(ledger.tryAcquire(key('alice'))).toBe(false);
    expect(ledger.tryAcquire(key('bob'))).toBe(true);
  });

  test('releaseIfProcessing does not clear a paid slot', () => {
    const ledger = new ZapLedger();
    ledger.tryAcquire(key('alice'));
    ledger.markPaid(key('alice'), 'hash-alice');

    // updateActivity throws here; releasing must not resurrect the payment.
    ledger.releaseIfProcessing(key('alice'));

    expect(ledger.get(key('alice'))?.state).toBe('paid');
    expect(ledger.tryAcquire(key('alice'))).toBe(false);
  });

  test('a paid slot keeps its payment hash after a release attempt', () => {
    const ledger = new ZapLedger();
    ledger.tryAcquire(key('alice'));
    ledger.markPaid(key('alice'), 'hash-alice');

    ledger.releaseIfProcessing(key('alice'));

    expect(ledger.get(key('alice'))?.paymentHash).toBe('hash-alice');
    expect(ledger.tryAcquire(key('alice'))).toBe(false);
  });

  test('an unknown slot cannot be acquired again', () => {
    const ledger = new ZapLedger();
    ledger.tryAcquire(key('alice'));
    ledger.markUnknown(key('alice'));

    expect(ledger.get(key('alice'))?.state).toBe('unknown');
    expect(ledger.tryAcquire(key('alice'))).toBe(false);
  });

  test('an unknown entry does not expire, unlike a paid one', () => {
    const ledger = new ZapLedger(-1); // any age is already past the TTL
    ledger.tryAcquire(key('alice'));
    ledger.markPaid(key('alice'), 'hash-alice');
    ledger.tryAcquire(key('bob'));
    ledger.markUnknown(key('bob'));

    expect(ledger.get(key('alice'))).toBeUndefined();
    expect(ledger.get(key('bob'))?.state).toBe('unknown');
  });

  test('the same card id in two conversations does not collide', () => {
    const ledger = new ZapLedger();
    const inConvA = key('alice');
    const inConvB = key('alice', { conversationId: 'conv-2' });

    expect(ledger.tryAcquire(inConvA)).toBe(true);
    expect(ledger.tryAcquire(inConvB)).toBe(true);
  });

  test('the same card id in two tenants does not collide', () => {
    const ledger = new ZapLedger();
    expect(ledger.tryAcquire(key('alice'))).toBe(true);
    expect(ledger.tryAcquire(key('alice', { tenantId: 'tenant-2' }))).toBe(true);
  });

  test('state is per recipient, so one card can pay several people', () => {
    const ledger = new ZapLedger();
    expect(ledger.tryAcquire(key('alice'))).toBe(true);
    expect(ledger.tryAcquire(key('bob'))).toBe(true);
    expect(ledger.tryAcquire(key('carol'))).toBe(true);
  });

  test('a fresh process starts with no state, so protection is not durable', () => {
    const first = new ZapLedger();
    first.tryAcquire(key('alice'));
    first.markPaid(key('alice'), 'hash-alice');

    // A restart is a brand new ledger: this documents the known limit rather
    // than asserting a guarantee the in-memory store cannot make.
    const afterRestart = new ZapLedger();
    expect(afterRestart.get(key('alice'))).toBeUndefined();
    expect(afterRestart.tryAcquire(key('alice'))).toBe(true);
  });
});
