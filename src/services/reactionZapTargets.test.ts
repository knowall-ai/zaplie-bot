// reactionZapTargets.test.ts — the configurable ⚡ reaction amount.
import { expect, describe, test, beforeEach, afterAll } from '@jest/globals';

import { MAX_ZAP_SATS } from '../commands/zapBudget';
import {
  zapReactionSats,
  ZAP_REACTION_DEFAULT_SATS,
} from './reactionZapTargets';

const originalReactionSats = process.env.ZAP_REACTION_SATS;

describe('zapReactionSats', () => {
  beforeEach(() => {
    delete process.env.ZAP_REACTION_SATS;
  });

  afterAll(() => {
    if (originalReactionSats === undefined) {
      delete process.env.ZAP_REACTION_SATS;
    } else {
      process.env.ZAP_REACTION_SATS = originalReactionSats;
    }
  });

  test('defaults to 21 when unset', () => {
    expect(zapReactionSats()).toBe(21);
    expect(ZAP_REACTION_DEFAULT_SATS).toBe(21);
  });

  test('defaults when set to blank, so an empty app setting is not a zero zap', () => {
    for (const blank of ['', '   ']) {
      process.env.ZAP_REACTION_SATS = blank;
      expect(zapReactionSats()).toBe(ZAP_REACTION_DEFAULT_SATS);
    }
  });

  test('returns the configured amount', () => {
    process.env.ZAP_REACTION_SATS = '210';
    expect(zapReactionSats()).toBe(210);
  });

  test('accepts the boundaries', () => {
    process.env.ZAP_REACTION_SATS = '1';
    expect(zapReactionSats()).toBe(1);
    process.env.ZAP_REACTION_SATS = String(MAX_ZAP_SATS);
    expect(zapReactionSats()).toBe(MAX_ZAP_SATS);
  });

  test('rejects anything that is not a positive whole number in range', () => {
    for (const invalid of [
      '0',
      '-21',
      '21.5',
      'twenty-one',
      'NaN',
      'Infinity',
      String(MAX_ZAP_SATS + 1),
    ]) {
      process.env.ZAP_REACTION_SATS = invalid;
      expect(zapReactionSats).toThrow(
        `ZAP_REACTION_SATS must be a whole number between 1 and ${MAX_ZAP_SATS}, received: ${invalid}`,
      );
    }
  });

  test('re-reads the environment on every call', () => {
    process.env.ZAP_REACTION_SATS = '50';
    expect(zapReactionSats()).toBe(50);
    process.env.ZAP_REACTION_SATS = '75';
    expect(zapReactionSats()).toBe(75);
  });
});
