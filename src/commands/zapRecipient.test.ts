// Exercises the production processZapRecipient used by the submitZaps loop,
// so a regression in the ledger transitions shows up here.
import { expect, describe, test, jest, beforeEach } from '@jest/globals';
import { ZapLedger, zapKey } from '../services/zapLedger';
import { PaymentOutcomeUnknownError } from './sendZapCommand';
import { validateZapSubmit } from './zapBudget';
import {
  getPendingRecipientIds,
  hasUnknownRecipientOutcome,
  normalizeRecipientIds,
  processZapRecipient,
  validateSelfZap,
} from './zapRecipient';

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

  test('a forged self-zap is rejected before the payment call', async () => {
    const pay = jest.fn(okPay);

    await expect(
      run(ledger, {
        getReceiver: async () => ({ ...receiverOk, id: 'sender-1' }),
        validateReceiver: receiver =>
          validateSelfZap({ id: 'sender-1' }, receiver),
        pay,
      }),
    ).resolves.toEqual({
      status: 'failed',
      label: 'Alice (you cannot zap yourself)',
    });

    expect(pay).not.toHaveBeenCalled();
    expect(ledger.get(ENTRY_KEY)).toBeUndefined();
    expect(
      validateSelfZap(
        { aadObjectId: 'aad-sender' },
        { aadObjectId: 'aad-sender' },
      ),
    ).toBe('you cannot zap yourself');
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
    expect(
      hasUnknownRecipientOutcome(ledger, ['alice'], () => ENTRY_KEY),
    ).toBe(true);

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

  test('a partial retry budgets only recipients that are still pending', async () => {
    await run(ledger);
    const entryKey = (recipientId: string) =>
      zapKey({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        cardId: 'card-1',
        recipientId,
      });

    const pending = getPendingRecipientIds(
      ledger,
      ['alice', 'bob'],
      entryKey,
    );

    expect(pending).toEqual(['bob']);
    expect(validateZapSubmit('100', pending.length, 100, 'Sats')).toBe(100);

    const retryPay = jest.fn(async () => ({ paymentHash: 'hash-bob' }));
    for (const recipientId of pending) {
      await processZapRecipient({
        ledger,
        entryKey: entryKey(recipientId),
        recipientId,
        getReceiver: async () => ({
          displayName: 'Bob',
          privateWallet: { id: 'wallet-bob' },
        }),
        pay: retryPay,
      });
    }

    expect(retryPay).toHaveBeenCalledTimes(1);
    expect(ledger.get(entryKey('alice'))?.paymentHash).toBe('hash-1');
    expect(ledger.get(entryKey('bob'))?.paymentHash).toBe('hash-bob');
  });

  test('normalizes and de-duplicates untrusted card recipient ids', () => {
    expect(normalizeRecipientIds([' alice ', 'alice', '', 42, 'bob'])).toEqual([
      'alice',
      'bob',
    ]);
    expect(normalizeRecipientIds('alice, bob,alice')).toEqual(['alice', 'bob']);
    expect(normalizeRecipientIds({ recipient: 'alice' })).toEqual([]);
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
