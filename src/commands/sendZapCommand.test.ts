// sendZapCommand.test.ts
//
// Covers the command's error hygiene: LNbits failures carry wallet ids and
// configuration names, so they belong in the logs and never in the chat.
// Also covers the receipt card builder: shape, key/value fields and the
// regression where a ColumnSet was nested inside another ColumnSet's columns
// array (invalid Adaptive Card JSON). The last block pins the payment
// metadata SendZap hands to LNbits: a projection of each wallet, never the
// wallet object with its keys.

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { TurnContext } from 'botbuilder';
import {
  SendZap,
  SendZapCommand,
  buildZapReceiptCard,
  zapAmountInput,
  zapAmountRegex,
} from './sendZapCommand';
import { MAX_ZAP_SATS } from './zapBudget';
import {
  createInvoice,
  getUsers,
  getWalletBalance,
  payInvoice,
} from '../services/lnbitsService';
import { GENERIC_ERROR_MESSAGE } from '../messages';

jest.mock('../services/lnbitsService');

const makeContext = () => {
  const sendActivity = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  return {
    sendActivity,
    context: {
      turnState: new Map<unknown, unknown>(),
      sendActivity,
    } as unknown as TurnContext,
  };
};

type CardElement = {
  type?: string;
  text?: string;
  columns?: CardElement[];
  items?: CardElement[];
  body?: CardElement[];
};

// Depth-first walk over every element of the card body.
const walk = (element: CardElement, visit: (el: CardElement) => void): void => {
  visit(element);
  for (const child of [
    ...(element.body ?? []),
    ...(element.columns ?? []),
    ...(element.items ?? []),
  ]) {
    walk(child, visit);
  }
};

const allText = (card: CardElement): string => {
  const texts: string[] = [];
  walk(card, el => {
    if (typeof el.text === 'string') {
      texts.push(el.text);
    }
  });
  return texts.join('\n');
};

const baseReceipt = {
  recipients: ['Bob'],
  message: 'Thanks for the review!',
  amount: 21,
  remainingBalance: 979,
  rewardName: 'Sats',
};

describe('SendZap after the payment settles', () => {
  const sender = {
    id: 'user-1',
    displayName: 'Alice',
    allowanceWallet: { id: 'w-alice', inkey: 'inkey-alice', adminkey: 'adm' },
  } as never;
  const receiver = {
    id: 'user-2',
    displayName: 'Bob',
    privateWallet: { id: 'w-bob', inkey: 'inkey-bob' },
  } as never;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a failed receipt card never turns a settled payment into a retryable error', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    jest.mocked(createInvoice).mockResolvedValue('lnbc-payment-request');
    jest
      .mocked(payInvoice)
      .mockResolvedValue({ payment_hash: 'hash-bob' } as never);
    // The balance read is presentation only, and it is the first thing the
    // receipt update does. Before this fix its failure escaped as a plain
    // Error, which zapRecipient reads as "never reached LNbits" and releases -
    // letting a resubmit pay Bob a second time.
    jest
      .mocked(getWalletBalance)
      .mockRejectedValue(new Error('LNbits balance read failed'));

    const updateActivity = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const context = {
      activity: { replyToId: 'card-1' },
      updateActivity,
    } as unknown as TurnContext;

    await expect(
      SendZap(sender, receiver, 'nice work', 21, context, true, 'Sats'),
    ).resolves.toEqual({ paymentHash: 'hash-bob' });
    expect(updateActivity).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('receipt card could not be updated'),
      expect.any(Error),
    );
  });

  test('a card update failure is logged, not thrown', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.mocked(createInvoice).mockResolvedValue('lnbc-payment-request');
    jest
      .mocked(payInvoice)
      .mockResolvedValue({ payment_hash: 'hash-bob' } as never);
    jest.mocked(getWalletBalance).mockResolvedValue(979 as never);

    const context = {
      activity: { replyToId: 'card-1' },
      updateActivity: jest
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('Teams rejected the card update')),
    } as unknown as TurnContext;

    await expect(
      SendZap(sender, receiver, 'nice work', 21, context, true, 'Sats'),
    ).resolves.toEqual({ paymentHash: 'hash-bob' });
  });
});

describe('SendZapCommand error hygiene', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('logs the failure and sends a generic message instead of error.message', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest
      .mocked(getUsers)
      .mockRejectedValue(
        new Error('LNbits admin key for wallet 0d1f rejected'),
      );
    const { context, sendActivity } = makeContext();

    await new SendZapCommand().execute(context);

    expect(sendActivity).toHaveBeenCalledWith(GENERIC_ERROR_MESSAGE);
    for (const [message] of sendActivity.mock.calls as unknown as [string][]) {
      expect(message).not.toContain('admin key');
    }
    expect(consoleError).toHaveBeenCalledWith(
      'SendZapCommand failed:',
      expect.objectContaining({
        message: expect.stringContaining('admin key'),
      }),
    );
  });
});

describe('buildZapReceiptCard', () => {
  test('produces a valid Adaptive Card 1.5 envelope', () => {
    const card = buildZapReceiptCard(baseReceipt);

    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe('1.5');
    expect(card.$schema).toBe(
      'http://adaptivecards.io/schemas/adaptive-card.json',
    );
    // Serializable, plain JSON.
    expect(() => JSON.stringify(card)).not.toThrow();
  });

  test('never nests a ColumnSet inside a columns array', () => {
    const card = buildZapReceiptCard({
      ...baseReceipt,
      recipients: ['Bob', 'Carol'],
      failedRecipients: ['Dave'],
    });

    walk(card as CardElement, element => {
      if (element.type === 'ColumnSet') {
        for (const column of element.columns ?? []) {
          expect(column.type).toBe('Column');
        }
      }
    });
  });

  test('shows the Receiver/Message/Amount/Remaining fields', () => {
    const text = allText(buildZapReceiptCard(baseReceipt) as CardElement);

    expect(text).toContain('Zap sent!');
    expect(text).toContain('Receiver:');
    expect(text).toContain('Bob');
    expect(text).toContain('Message:');
    expect(text).toContain('Thanks for the review!');
    expect(text).toContain('Amount (Sats):');
    expect(text).toContain('21');
    expect(text).toContain('Remaining Amount (Sats):');
    expect(text).toContain('979');
  });

  test('lists every recipient and the total on a multi-recipient receipt', () => {
    const card = buildZapReceiptCard({
      ...baseReceipt,
      recipients: ['Bob', 'Carol', 'Dave'],
    }) as CardElement;
    const text = allText(card);

    expect(text).toContain('Receivers:');
    expect(text).toContain('Bob, Carol, Dave');
    expect(text).toContain('Total Sent (Sats):');
    expect(text).toContain('63');
  });

  test('shows failed recipients only when there are failures', () => {
    const clean = allText(buildZapReceiptCard(baseReceipt) as CardElement);
    expect(clean).not.toContain('Failed Receivers');

    const withFailure = allText(
      buildZapReceiptCard({
        ...baseReceipt,
        failedRecipients: ['Dave'],
      }) as CardElement,
    );
    expect(withFailure).toContain('Failed Receivers');
    expect(withFailure).toContain('- Dave');
  });

  test('reports an unconfirmed payment apart from the failures', () => {
    const clean = allText(buildZapReceiptCard(baseReceipt) as CardElement);
    expect(clean).not.toContain('Needs checking');

    const blocks: string[] = [];
    walk(
      buildZapReceiptCard({
        ...baseReceipt,
        failedRecipients: ['Erin'],
        uncertainRecipients: ['Dave'],
      }) as CardElement,
      element => {
        if (typeof element.text === 'string') {
          blocks.push(element.text);
        }
      },
    );

    const needsChecking = blocks.find(text => text.includes('Needs checking'));
    expect(needsChecking).toContain('- Dave');
    expect(needsChecking).toContain(
      'Payment outcome uncertain — an admin should verify before retrying.',
    );
    // Dave's payment may have settled: listing him as failed would invite a
    // retry that pays him twice.
    const failed = blocks.find(text => text.includes('Failed Receivers'));
    expect(failed).toContain('- Erin');
    expect(failed).not.toContain('Dave');
  });

  test('groups large amounts for readability', () => {
    const text = allText(
      buildZapReceiptCard({
        ...baseReceipt,
        recipients: ['Bob', 'Carol'],
        amount: 2500,
        remainingBalance: 12000,
      }) as CardElement,
    );

    expect(text).toContain((2500).toLocaleString());
    expect(text).toContain((5000).toLocaleString());
    expect(text).toContain((12000).toLocaleString());
  });
});

describe('zapAmountRegex', () => {
  // Exhaustive: every value from 0 to a little past the cap, plus the forms a
  // regex is most likely to get wrong.
  const accepts = (cap: number, value: string): boolean =>
    new RegExp(zapAmountRegex(cap)).test(value);

  test.each([1, 9, 10, 11, 99, 100, 250, 999, 1000, 4687, 10000, 14687])(
    'matches exactly the whole numbers 1..%i',
    cap => {
      for (let value = 0; value <= cap + 12; value++) {
        expect([value, accepts(cap, String(value))]).toEqual([
          value,
          value >= 1 && value <= cap,
        ]);
      }
      // One digit more than the cap, a leading zero, and ten times the cap.
      for (const value of [`1${cap}`, `0${cap}`, `${cap}0`]) {
        expect([value, accepts(cap, value)]).toEqual([value, false]);
      }
    },
  );

  test('rejects leading zeros, decimals, signs, spaces and empty input', () => {
    for (const value of [
      '',
      '0',
      '007',
      '1.5',
      '-5',
      '+5',
      ' 5',
      '5 ',
      '1e3',
    ]) {
      expect([value, accepts(250, value)]).toEqual([value, false]);
    }
  });

  test('a cap below 1 accepts nothing', () => {
    for (const value of ['', '0', '1', '100']) {
      expect(accepts(0, value)).toBe(value === '');
    }
  });

  test('the ceiling reproduces the original 1..10,000 rule', () => {
    expect(accepts(10000, '10000')).toBe(true);
    expect(accepts(10000, '10001')).toBe(false);
    expect(accepts(10000, '9999')).toBe(true);
  });
});

describe('the zap card caps the amount at the live balance', () => {
  type AmountInput = {
    type: string;
    id: string;
    regex?: string;
    isRequired?: boolean;
    errorMessage?: string;
  };

  // Sends the card through the real command and returns its amount input and
  // the card text, so the cap is tested where Teams reads it.
  const cardFor = async (balance: number) => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.mocked(getUsers).mockResolvedValue([]);
    jest.mocked(getWalletBalance).mockResolvedValue(balance as never);
    const { context, sendActivity } = makeContext();
    (context.turnState as Map<unknown, unknown>).set('user', {
      id: 'user-1',
      displayName: 'Alice',
      allowanceWallet: { id: 'w-alice', inkey: 'inkey-alice', adminkey: 'adm' },
    });

    await new SendZapCommand().execute(context);

    const [activity] = sendActivity.mock.calls[0] as unknown as [
      { attachments: { content: CardElement }[] },
    ];
    const card = activity.attachments[0].content;
    const amount = (card.body ?? []).find(
      element => (element as AmountInput).id === 'zapAmount',
    ) as AmountInput | undefined;
    if (!amount) {
      throw new Error('zapAmount input missing from the card');
    }
    return { amount, text: allText(card) };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a balance below the ceiling caps the input at the balance', async () => {
    const { amount, text } = await cardFor(250);

    expect(amount).toMatchObject({
      type: 'Input.Text',
      id: 'zapAmount',
      isRequired: true,
      regex: zapAmountRegex(250),
    });
    expect(new RegExp(amount.regex ?? '').test('250')).toBe(true);
    expect(new RegExp(amount.regex ?? '').test('251')).toBe(false);
    expect(amount.errorMessage).toMatch(/don't have that many .* up to 250\./);
    expect(text).toContain('250');
  });

  test('a balance above the ceiling caps the input at the ceiling', async () => {
    const { amount } = await cardFor(25_000);

    expect(amount.regex).toBe(zapAmountRegex(MAX_ZAP_SATS));
    expect(amount.errorMessage).toContain(MAX_ZAP_SATS.toLocaleString());
  });

  test('an empty balance leaves nothing sendable and says so', async () => {
    const { amount } = await cardFor(0);

    expect(new RegExp(amount.regex ?? '').test('1')).toBe(false);
    expect(amount.errorMessage).toMatch(/^You have no .* to send right now\.$/);
  });

  test('an unreadable balance builds no card at all: the generic error, as for a rejected read', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.mocked(getUsers).mockResolvedValue([]);
    jest.mocked(getWalletBalance).mockResolvedValue(Number.NaN as never);
    const { context, sendActivity } = makeContext();
    (context.turnState as Map<unknown, unknown>).set('user', {
      id: 'user-1',
      displayName: 'Alice',
      allowanceWallet: { id: 'w-alice', inkey: 'inkey-alice', adminkey: 'adm' },
    });

    await new SendZapCommand().execute(context);

    expect(sendActivity).toHaveBeenCalledTimes(1);
    expect(sendActivity).toHaveBeenCalledWith(GENERIC_ERROR_MESSAGE);
  });

  test('the input helper alone treats an unreadable balance as the ceiling (defence in depth)', () => {
    expect(zapAmountInput(Number.NaN, 'Sats').regex).toBe(
      zapAmountRegex(MAX_ZAP_SATS),
    );
  });

  test('a fractional balance rounds down', () => {
    expect(zapAmountInput(99.9, 'Sats').regex).toBe(zapAmountRegex(99));
  });
});

// Every key found anywhere inside a value, depth first.
const collectKeys = (
  value: unknown,
  found: Set<string> = new Set(),
): Set<string> => {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      found.add(key);
      collectKeys(child, found);
    }
  }
  return found;
};

const makeWallet = (overrides: Partial<Wallet>): Wallet => ({
  id: 'wallet-id',
  admin: 'admin-id',
  name: 'Allowance',
  user: 'user-id',
  adminkey: 'adminkey-value',
  inkey: 'inkey-value',
  balance_msat: 100000,
  deleted: false,
  ...overrides,
});

const sender: User = {
  id: 'sender-id',
  displayName: 'Ada Sender',
  profileImg: '',
  aadObjectId: 'aad-sender',
  email: 'ada@example.test',
  privateWallet: makeWallet({
    id: 'sender-private',
    name: 'Private',
    user: 'sender-user',
    adminkey: 'sender-private-adminkey',
    inkey: 'sender-private-inkey',
  }),
  allowanceWallet: makeWallet({
    id: 'sender-allowance',
    name: 'Allowance',
    user: 'sender-user',
    adminkey: 'sender-allowance-adminkey',
    inkey: 'sender-allowance-inkey',
  }),
};

const receiver: User = {
  id: 'receiver-id',
  displayName: 'Bob Receiver',
  profileImg: '',
  aadObjectId: 'aad-receiver',
  email: 'bob@example.test',
  privateWallet: makeWallet({
    id: 'receiver-private',
    name: 'Private',
    user: 'receiver-user',
    adminkey: 'receiver-private-adminkey',
    inkey: 'receiver-private-inkey',
  }),
  allowanceWallet: makeWallet({
    id: 'receiver-allowance',
    name: 'Allowance',
    user: 'receiver-user',
    adminkey: 'receiver-allowance-adminkey',
    inkey: 'receiver-allowance-inkey',
  }),
};

const SECRET_VALUES = [
  'sender-allowance-adminkey',
  'sender-allowance-inkey',
  'sender-private-adminkey',
  'sender-private-inkey',
  'receiver-private-adminkey',
  'receiver-private-inkey',
  'receiver-allowance-adminkey',
  'receiver-allowance-inkey',
];

describe('SendZap payment metadata', () => {
  const sendOneZap = async (from: User = sender, to: User = receiver) => {
    jest.mocked(createInvoice).mockResolvedValue('lnbc1-payment-request');
    jest.mocked(payInvoice).mockResolvedValue({ payment_hash: 'hash-1' });
    const { context } = makeContext();

    await SendZap(from, to, 'thanks', 21, context, false, 'Sats');

    return {
      invoiceExtra: jest.mocked(createInvoice).mock.calls[0][4],
      paymentExtra: jest.mocked(payInvoice).mock.calls[0][2],
    };
  };

  afterEach(() => {
    jest.mocked(createInvoice).mockReset();
    jest.mocked(payInvoice).mockReset();
  });

  test('never sends wallet keys or balances in the payment metadata', async () => {
    const { invoiceExtra, paymentExtra } = await sendOneZap();

    for (const extra of [invoiceExtra, paymentExtra]) {
      const keys = collectKeys(extra);
      expect(keys.has('adminkey')).toBe(false);
      expect(keys.has('inkey')).toBe(false);
      expect(keys.has('balance_msat')).toBe(false);
      const serialised = JSON.stringify(extra);
      for (const secret of SECRET_VALUES) {
        expect(serialised).not.toContain(secret);
      }
    }
  });

  test('shapes from and to as id, name, user and displayName', async () => {
    const { invoiceExtra } = await sendOneZap();

    expect(invoiceExtra).toEqual({
      tag: 'zap',
      from: {
        id: 'sender-allowance',
        name: 'Allowance',
        user: 'sender-user',
        displayName: 'Ada Sender',
      },
      to: {
        id: 'receiver-private',
        name: 'Private',
        user: 'receiver-user',
        displayName: 'Bob Receiver',
      },
    });
  });

  test('keeps the fields the portal feed and automation readers use', async () => {
    // FeedList.tsx reads extra.from.user and extra.to.user,
    // automationPayments.js reads extra.to.id and extra.to.displayName,
    // WalletTransactionLog.tsx reads extra.tag.
    const { invoiceExtra } = await sendOneZap();
    const extra = invoiceExtra as {
      tag: string;
      from: { user: string };
      to: { id: string; user: string; displayName: string };
    };

    expect(extra.tag).toBe('zap');
    expect(extra.from.user).toBe('sender-user');
    expect(extra.to.user).toBe('receiver-user');
    expect(extra.to.id).toBe('receiver-private');
    expect(extra.to.displayName).toBe('Bob Receiver');
  });

  test('sends the same metadata on the invoice and on the payment', async () => {
    const { invoiceExtra, paymentExtra } = await sendOneZap();

    expect(paymentExtra).toEqual(invoiceExtra);
  });

  test('pays from the sender Allowance adminkey into an invoice on the receiver Private inkey', async () => {
    await sendOneZap();

    expect(createInvoice).toHaveBeenCalledWith(
      'receiver-private-inkey',
      'receiver-private',
      21,
      'thanks',
      expect.anything(),
    );
    expect(payInvoice).toHaveBeenCalledWith(
      'sender-allowance-adminkey',
      'lnbc1-payment-request',
      expect.anything(),
    );
  });

  test('does not create an invoice when the receiver has no Private wallet', async () => {
    const receiverWithoutPrivate: User = { ...receiver, privateWallet: null };

    await expect(sendOneZap(sender, receiverWithoutPrivate)).rejects.toThrow(
      /receiver Private wallet is missing/,
    );
    expect(createInvoice).not.toHaveBeenCalled();
  });

  test('does not pay when the invoice cannot be created', async () => {
    jest.mocked(createInvoice).mockRejectedValue(new Error('LNbits down'));
    jest.mocked(payInvoice).mockResolvedValue({ payment_hash: 'hash-1' });
    const { context } = makeContext();

    await expect(
      SendZap(sender, receiver, 'thanks', 21, context, false, 'Sats'),
    ).rejects.toThrow('LNbits down');
    expect(payInvoice).not.toHaveBeenCalled();
  });

  test('does not create an invoice when the sender has no Allowance wallet', async () => {
    const senderWithoutAllowance: User = { ...sender, allowanceWallet: null };

    await expect(sendOneZap(senderWithoutAllowance, receiver)).rejects.toThrow(
      /sender Allowance wallet is missing/,
    );
    expect(createInvoice).not.toHaveBeenCalled();
    expect(payInvoice).not.toHaveBeenCalled();
  });
});

// The card a Spanish client receives is Spanish end to end: form labels,
// validation hints, the balance line, the button, and the receipt it turns
// into. Wallet names, amounts and the reward label stay as they are.
describe('zap card and receipt in the user language', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('renders the receipt in Spanish', () => {
    const text = allText(
      buildZapReceiptCard(
        {
          ...baseReceipt,
          recipients: ['Bob', 'Carol'],
          failedRecipients: ['Dave'],
          uncertainRecipients: ['Erin'],
        },
        'es',
      ) as CardElement,
    );

    for (const expected of [
      '¡Zap enviado!',
      'Destinatarios:',
      'Bob, Carol',
      'Mensaje:',
      'Thanks for the review!',
      'Cantidad (Sats):',
      'Total enviado (Sats):',
      'Saldo restante (Sats):',
      '**Destinatarios fallidos:**',
      '- Dave',
      '**Por verificar:**',
      '- Erin',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('Zap sent!');
  });

  test('defaults the receipt to English', () => {
    expect(allText(buildZapReceiptCard(baseReceipt) as CardElement)).toContain(
      'Zap sent!',
    );
  });

  test('sends the zap card in Spanish for a Spanish client', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest
      .mocked(getUsers)
      .mockResolvedValue([
        { id: 'user-2', displayName: 'Bob', aadObjectId: 'aad-2' } as never,
      ]);
    jest.mocked(getWalletBalance).mockResolvedValue(15000);
    const { context, sendActivity } = makeContext();
    (context as unknown as { activity: unknown }).activity = {
      locale: 'es-MX',
    };
    (context.turnState as Map<unknown, unknown>).set('user', {
      id: 'user-1',
      allowanceWallet: { id: 'w-1', inkey: 'inkey-1', adminkey: 'adm-1' },
    });

    await new SendZapCommand().execute(context);

    const [message] = sendActivity.mock.calls[0] as unknown as [
      { attachments: { content: unknown }[] },
    ];
    const card = JSON.stringify(message.attachments[0].content);
    // The reward label is read when the module loads, so this file does not
    // pin it; the label-bearing strings are checked up to the label.
    for (const expected of [
      'Destinatario',
      'Selecciona una o más carteras destinatarias',
      'Debes seleccionar al menos a una persona',
      'Mensaje',
      '¡Gracias por ayudarme con la propuesta!',
      'Cantidad (',
      'Indica un número entero entre 1 y 10,000',
      '**Saldo disponible (',
      '15000',
      'Enviar zap',
    ]) {
      expect(card).toContain(expected);
    }
    expect(card).not.toContain('Send Zap');
    // The submit payload the handler keys on is unchanged.
    expect(card).toContain('"action":"submitZaps"');
  });
});
