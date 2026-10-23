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
  formatNumber,
  numberLocale,
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

  // A typo at a call site must be visible, not "your balance is ." (Ben's
  // pre-merge point 4): the token stays and the logs say which one.
  test('leaves a missing parameter visible and warns instead of rendering empty text', () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    expect(t('en', 'couldNotComplete', {})).toBe(
      'Could not complete: {{recipients}}.',
    );
    expect(t('es', 'balanceLine', { walletName: 'Private' })).toBe(
      'Tu cartera Private tiene un saldo de {{balance}} {{rewardName}}.',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('missing parameter "recipients"'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('missing parameter "balance"'),
    );
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

// Ben's pre-merge point 1: numbers follow the client's full tag, because the
// region decides the separators. Verified against Node 24's ICU.
describe('formatNumber', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('groups for the Spanish region the client sent', () => {
    expect(formatNumber(10000, 'es-ES')).toBe('10.000');
    expect(formatNumber(10000, 'es')).toBe('10.000');
    expect(formatNumber(10000, 'es-MX')).toBe('10,000');
    expect(formatNumber(10000, 'es-419')).toBe('10,000');
    expect(formatNumber(10000, 'es_MX')).toBe('10,000');
    expect(formatNumber(10000, ' es-mx ')).toBe('10,000');
    // Spain leaves four-digit numbers ungrouped.
    expect(formatNumber(1000, 'es-ES')).toBe('1000');
  });

  test('formats everything else as English, the language of the copy', () => {
    for (const locale of [
      'en-US',
      'de-DE',
      'fr-FR',
      'es-@@',
      'es--MX',
      '',
      undefined,
      null,
      42,
    ]) {
      expect({ locale, text: formatNumber(10000, locale) }).toEqual({
        locale,
        text: '10,000',
      });
    }
  });

  test('never uses the server locale', () => {
    jest
      .spyOn(Number.prototype, 'toLocaleString')
      .mockReturnValue('SERVER-LOCALE');
    expect(formatNumber(10000, 'es-ES')).toBe('10.000');
    expect(formatNumber(10000, 'en')).toBe('10,000');
  });

  test('t formats number parameters for the tag and leaves strings alone', () => {
    expect(
      t('es-ES', 'budgetExceeded', {
        total: 18000,
        rewardName: 'Sats',
        count: 2,
        balance: 12500,
      }),
    ).toBe(
      'Eso enviaría 18.000 Sats entre 2 destinatario(s), pero tu saldo es 12.500. No se envió ningún zap.',
    );
    expect(
      t('es-MX', 'cardAmountErrorRange', { max: 10000, rewardName: 'Sats' }),
    ).toBe('Indica un número entero entre 1 y 10,000 Sats.');
    expect(t('en-GB', 'zapSent', { amount: 2100, rewardName: 'Sats' })).toBe(
      'Awesome! You sent 2,100 Sats to your colleague with a zap!',
    );
    expect(numberLocale('es_mx')).toBe('es-MX');
    expect(numberLocale('pt-BR')).toBe('en');
  });
});
