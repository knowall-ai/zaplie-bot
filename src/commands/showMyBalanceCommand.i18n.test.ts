// showMyBalanceCommand.i18n.test.ts
//
// The balance command answers in the language of the Teams client that asked
// (Spanish for any es-* locale, English otherwise); the wallet names and the
// reward label are data and come through untouched.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import type { TurnContext } from 'botbuilder';
import { getBalances } from '../services/peopleDirectory';
import { ShowMyBalanceCommand } from './showMyBalanceCommand';

jest.mock('../services/peopleDirectory');

const originalPointsLabel = process.env.LNBITS_POINTS_LABEL;

const makeContext = (locale: unknown) => {
  const sendActivity = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const turnState = new Map<unknown, unknown>();
  turnState.set('user', {
    id: 'u-1',
    aadObjectId: 'aad-1',
    allowanceWallet: { id: 'w-allowance' },
  });
  const context = {
    activity: { type: 'message', locale, from: { id: 'user-1' } },
    turnState,
    sendActivity,
  } as unknown as TurnContext;
  return { context, sendActivity };
};

const replies = (sendActivity: jest.Mock) =>
  sendActivity.mock.calls.map(call => call[0]);

describe('ShowMyBalanceCommand languages', () => {
  let consoleLog: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    process.env.LNBITS_POINTS_LABEL = 'Sats';
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest
      .mocked(getBalances)
      .mockResolvedValue({ allowanceSats: 21, privateSats: 5 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalPointsLabel === undefined) {
      delete process.env.LNBITS_POINTS_LABEL;
    } else {
      process.env.LNBITS_POINTS_LABEL = originalPointsLabel;
    }
  });

  test('answers in Spanish for a Spanish Teams client', async () => {
    const { context, sendActivity } = makeContext('es-MX');

    await new ShowMyBalanceCommand().execute(context);

    expect(replies(sendActivity)).toEqual([
      'Tu cartera Allowance tiene un saldo de 21 Sats.',
      'Tu cartera Private tiene un saldo de 5 Sats.',
    ]);
    expect(consoleLog).toHaveBeenCalled();
  });

  test('answers in English for any other client, including a missing locale', async () => {
    for (const locale of ['fr-FR', undefined]) {
      const { context, sendActivity } = makeContext(locale);

      await new ShowMyBalanceCommand().execute(context);

      expect(replies(sendActivity)).toEqual([
        'Your Allowance wallet has a balance of 21 Sats.',
        'Your Private wallet has a balance of 5 Sats.',
      ]);
    }
  });

  test('reports a wallet without a balance in the user language', async () => {
    jest
      .mocked(getBalances)
      .mockResolvedValue({ allowanceSats: null, privateSats: null });
    const { context, sendActivity } = makeContext('es-ES');

    await new ShowMyBalanceCommand().execute(context);

    expect(replies(sendActivity)).toEqual([
      'La información de saldo no está disponible para la cartera w-allowance.',
      'Tu cartera Private es tuya y Zaplie no la lee. Registra una clave de factura en la página Wallet del portal para ver aquí su saldo.',
    ]);
  });

  test('renders the failure message in the user language and keeps details in the logs', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    jest
      .mocked(getBalances)
      .mockRejectedValue(new Error('inkey abc123 leaked'));
    const { context, sendActivity } = makeContext('es');

    await new ShowMyBalanceCommand().execute(context);

    expect(replies(sendActivity)).toEqual([
      'Lo siento, algo salió mal al mostrar tu saldo.',
    ]);
    expect(consoleError).toHaveBeenCalledWith(
      'Error in ShowMyBalanceCommand:',
      expect.objectContaining({ message: 'inkey abc123 leaked' }),
    );
  });
});
