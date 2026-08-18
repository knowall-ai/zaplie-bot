// sendZapCommand.test.ts
//
// Covers the command's error hygiene: LNbits failures carry wallet ids and
// configuration names, so they belong in the logs and never in the chat.
// Also covers the receipt card builder: shape, key/value fields and the
// regression where a ColumnSet was nested inside another ColumnSet's columns
// array (invalid Adaptive Card JSON).

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { TurnContext } from 'botbuilder';
import { SendZapCommand, buildZapReceiptCard } from './sendZapCommand';
import { getUsers } from '../services/lnbitsService';
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
