import { expect, describe, test } from '@jest/globals';
import { validateZapSubmit } from './zapBudget';

describe('validateZapSubmit', () => {
  test('returns the parsed amount for a valid single zap', () => {
    expect(validateZapSubmit('100', 1, 100, 'Sats')).toBe(100);
  });

  test('rejects the cumulative total across recipients, not just one', () => {
    // 3 x 100 = 300 against a 100 balance: the bug this guard closes
    expect(() => validateZapSubmit('100', 3, 100, 'Sats')).toThrow(
      'That would send 300 Sats across 3 recipient(s) but your balance is 100',
    );
  });

  test('rejects a negative forged amount', () => {
    expect(() => validateZapSubmit('-100', 1, 1000, 'Sats')).toThrow(
      'whole number between 1 and 10,000',
    );
  });

  test('rejects a fractional amount', () => {
    expect(() => validateZapSubmit('0.5', 1, 1000, 'Sats')).toThrow(
      'whole number between 1 and 10,000',
    );
  });

  test('rejects an amount over the cap', () => {
    expect(() => validateZapSubmit('10001', 1, 999999, 'Sats')).toThrow(
      'whole number between 1 and 10,000',
    );
  });

  test('allows spending the exact balance', () => {
    expect(validateZapSubmit('50', 2, 100, 'Sats')).toBe(50);
  });
});
