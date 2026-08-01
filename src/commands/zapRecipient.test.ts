// Exercises the production processZapRecipient used by the submitZaps loop,
// so a regression in the ledger transitions shows up here.
import { expect, describe, test, jest, beforeEach } from '@jest/globals';
import { ZapLedger, zapKey } from '../services/zapLedger';
import { PaymentOutcomeUnknownError } from './sendZapCommand';
import { processZapRecipient } from './zapRecipient';

const ENTRY_KEY = zapKey({
  tenantId: 'tenant-1',
  conversationId: 'conv-1',
  cardId: 'card-1',
  recipientId: 'alice',
});

const receiverOk = { displayName: 'Alice', privateWallet: { id: 'w1' } };
const okPay = async () => ({ paymentHash: 'hash-1' });

const run = (
  ledger: ZapLedger,
  overrides: Partial<Parameters<typeof processZapRecipient>[0]> = {},
) =>
  processZapRecipient({
    ledger,
    entryKey: ENTRY_KEY,
    recipientId: 'alice',
    getReceiver: async () => receiverOk,
    pay: okPay,
    ...overrides,
  });

describe('processZapRecipient', () => {
  let ledger: ZapLedger;
  beforeEach(() => {
    ledger = new ZapLedger();
  });

  test('a confirmed payment records the hash', async () => {
    await expect(run(ledger)).resolves.toEqual({ status: 'paid', label: 'Alice' });
    expect(ledger.get(ENTRY_KEY)).toMatchObject({
      state: 'paid',
      paymentHash: 'hash-1',
    });
  });

  test('a getReceiver failure frees the slot so a retry can pay', async () => {
    await expect(
      run(ledger, {
        getReceiver: async () => {
          throw new Error('LNbits unreachable');
        },
      }),
    ).rejects.toThrow('LNbits unreachable');

    expect(ledger.get(ENTRY_KEY)).toBeUndefined();
    await expect(run(ledger)).resolves.toMatchObject({ status: 'paid' });
  });

  test('a null receiver frees the slot instead of throwing', async () => {
    await expect(run(ledger, { getReceiver: async () => null })).resolves.toEqual({
      status: 'failed',
      label: 'User ID: alice',
    });
    expect(ledger.get(ENTRY_KEY)).toBeUndefined();
  });

  test('a missing private wallet frees the slot', async () => {
    await expect(
      run(ledger, { getReceiver: async () => ({ displayName: 'Alice' }) }),
    ).resolves.toEqual({ status: 'failed', label: 'Alice' });
    expect(ledger.get(ENTRY_KEY)).toBeUndefined();
  });

  test('an insufficient balance frees the slot so a retry can pay', async () => {
    await expect(
      run(ledger, {
        pay: async () => {
          throw new Error('You cannot send more than your available balance.');
        },
      }),
    ).resolves.toMatchObject({ status: 'failed' });

    expect(ledger.get(ENTRY_KEY)).toBeUndefined();
    await expect(run(ledger)).resolves.toMatchObject({ status: 'paid' });
  });

  test('an ambiguous payment failure is kept as unknown and never retried', async () => {
    await expect(
      run(ledger, {
        pay: async () => {
          throw new PaymentOutcomeUnknownError('LNbits timed out after sending');
        },
      }),
    ).resolves.toMatchObject({ status: 'needs-checking' });

    expect(ledger.get(ENTRY_KEY)?.state).toBe('unknown');

    const retryPay = jest.fn(okPay);
    await expect(run(ledger, { pay: retryPay })).resolves.toEqual({ status: 'skipped' });
    expect(retryPay).not.toHaveBeenCalled();
  });

  test('a duplicated submit pays nobody', async () => {
    await run(ledger);

    const secondPay = jest.fn(okPay);
    await expect(run(ledger, { pay: secondPay })).resolves.toEqual({ status: 'skipped' });
    expect(secondPay).not.toHaveBeenCalled();
  });

  test('a card update failure after payment does not re-enable the payment', async () => {
    await run(ledger);

    // updateActivity throwing is handled outside this function; the entry must
    // survive a release attempt untouched.
    ledger.releaseIfProcessing(ENTRY_KEY);

    const secondPay = jest.fn(okPay);
    await expect(run(ledger, { pay: secondPay })).resolves.toEqual({ status: 'skipped' });
    expect(secondPay).not.toHaveBeenCalled();
    expect(ledger.get(ENTRY_KEY)?.paymentHash).toBe('hash-1');
  });
});
