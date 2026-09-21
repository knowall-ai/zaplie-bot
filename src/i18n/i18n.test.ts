// i18n.test.ts
//
// Pins the language resolution and the rendering rules the bot copy relies
// on: a mismatch or a missing translation must never fail a turn.

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  Dictionaries,
  MessageKey,
  en,
  es,
  resolveLocale,
  t,
  translateWith,
} from './index';

describe('resolveLocale', () => {
  test('maps any Spanish variant to es', () => {
    for (const locale of [
      'es',
      'es-ES',
      'es-MX',
      'es-419',
      'es_MX',
      'ES-es',
      ' es-SV ',
    ]) {
      expect(resolveLocale(locale)).toBe('es');
    }
  });

  test('falls back to English for anything else', () => {
    for (const locale of [
      'en-US',
      'en-GB',
      'fr-FR',
      'pt-BR',
      '',
      'zz-@@',
      'es-@@',
      'es--MX',
      'es-',
      'es-toolongsubtag',
      'español',
      'es MX',
      'español',
      undefined,
      null,
      42,
      {},
    ]) {
      expect(resolveLocale(locale)).toBe('en');
    }
  });
});

describe('t', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('renders English by default and Spanish for es', () => {
    expect(t('en', 'noZapsSent')).toBe('No zaps were sent.');
    expect(t('es', 'noZapsSent')).toBe('No se envió ningún zap.');
  });

  test('fills every placeholder and copies parameters literally', () => {
    expect(t('en', 'zapSent', { amount: 21, rewardName: 'Sats' })).toBe(
      'Awesome! You sent 21 Sats to your colleague with a zap!',
    );
    // A function replacer copies `$&` as text; a string replacer would
    // expand it to the matched placeholder.
    expect(
      t('es', 'balanceLine', {
        walletName: 'Allowance',
        balance: '$& 1,000',
        rewardName: 'Sats',
      }),
    ).toBe('Tu cartera Allowance tiene un saldo de $& 1,000 Sats.');
  });

  test('renders a missing parameter as empty text rather than the placeholder', () => {
    expect(t('en', 'couldNotComplete')).toBe('Could not complete: .');
  });

  test('every English placeholder exists in the Spanish copy, and vice versa', () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();
    for (const key of Object.keys(en) as MessageKey[]) {
      expect({ key, es: placeholders(es[key]) }).toEqual({
        key,
        es: placeholders(en[key]),
      });
    }
  });

  test('no Spanish entry is empty', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect({ key, empty: es[key].trim() === '' }).toEqual({
        key,
        empty: false,
      });
    }
  });

  test('falls back to English with a warning when a translation is missing', () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const dicts: Dictionaries = { en, es: { ...es, noZapsSent: '' } };

    expect(translateWith(dicts, 'es', 'noZapsSent')).toBe('No zaps were sent.');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no es copy for "noZapsSent"'),
    );
    // English never warns about itself.
    warn.mockClear();
    expect(translateWith(dicts, 'en', 'noZapsSent')).toBe('No zaps were sent.');
    expect(warn).not.toHaveBeenCalled();
  });
});
