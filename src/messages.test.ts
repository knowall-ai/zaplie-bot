// The line a zap recipient receives carries the sender's own words, so it
// is bounded and flattened here, not trusted from the card.
import { describe, expect, jest, test } from '@jest/globals';
import {
  ZAP_MEMO_PREVIEW_MAX,
  assistantUnavailableGuide,
  greetingGuide,
  isGreeting,
  unrecognizedCommandGuide,
  welcomeMessage,
  zapMemoPreview,
  zapReceivedMessage,
} from './messages';

describe('zapReceivedMessage', () => {
  test('names the sender, the amount, the reward and the memo', () => {
    expect(
      zapReceivedMessage({
        senderName: 'Alice',
        amount: 2100,
        rewardName: 'Sats',
        message: 'Thanks for the review!',
      }),
    ).toBe('⚡ Alice zapped you 2,100 Sats: "Thanks for the review!"');
  });

  // The recipient notice is a proactive message with no recipient activity,
  // so there is no client locale to follow: it stays English, and so do its
  // numbers, whatever the server's own default locale is (Ben's point 1).
  test('writes the amount in English whatever the server locale', () => {
    const spy = jest
      .spyOn(Number.prototype, 'toLocaleString')
      .mockReturnValue('SERVER-LOCALE');
    try {
      expect(
        zapReceivedMessage({
          senderName: 'Alice',
          amount: 12000,
          rewardName: 'Sats',
          message: 'gracias',
        }),
      ).toBe('⚡ Alice zapped you 12,000 Sats: "gracias"');
    } finally {
      spy.mockRestore();
    }
  });

  test('falls back to a neutral sender name', () => {
    expect(
      zapReceivedMessage({
        senderName: '',
        amount: 1,
        rewardName: 'Sats',
        message: 'hi',
      }),
    ).toContain('A colleague zapped you');
  });
});

describe('zapMemoPreview', () => {
  test('collapses newlines and whitespace runs into one line', () => {
    expect(zapMemoPreview('  great\n\n\n   pairing \t session  ')).toBe(
      'great pairing session',
    );
  });

  test('leaves a memo within the limit untouched', () => {
    const memo = 'x'.repeat(ZAP_MEMO_PREVIEW_MAX);
    expect(zapMemoPreview(memo)).toBe(memo);
  });

  test('cuts a long memo at the limit with an ellipsis', () => {
    const preview = zapMemoPreview('y'.repeat(5087));
    expect(Array.from(preview)).toHaveLength(ZAP_MEMO_PREVIEW_MAX);
    expect(preview.endsWith('…')).toBe(true);
  });

  test('cuts at a code point boundary, never inside an emoji', () => {
    const preview = zapMemoPreview('⚡'.repeat(300));
    expect(Array.from(preview)).toHaveLength(ZAP_MEMO_PREVIEW_MAX);
    expect(preview.startsWith('⚡⚡')).toBe(true);
    expect(preview.endsWith('⚡…')).toBe(true);
  });
});

describe('command guides', () => {
  const names = ['send zap', 'show my balance', 'show leaderboard'];

  test.each([
    ['unrecognizedCommandGuide', unrecognizedCommandGuide],
    ['greetingGuide', greetingGuide],
    ['welcomeMessage', welcomeMessage],
  ])(
    '%s ends the list with a blank line, so the last sentence is not part of the last bullet',
    (_name, guide) => {
      const lines = guide(names).split('\n');
      expect(lines[lines.length - 3]).toBe('- **show leaderboard**');
      expect(lines[lines.length - 2]).toBe('');
      expect(lines[lines.length - 1]).toMatch(/to get started!$/);
    },
  );

  test.each([
    'hi',
    'Hi Zaplie!',
    'hello',
    'Hey there',
    'hiya zaplie',
    'good morning',
    '  Morning!  ',
    'hi 👋',
  ])('%j is a greeting', text => {
    expect(isGreeting(text)).toBe(true);
  });

  test.each([
    'hi, send 100 sats to bob',
    'history',
    'hello world',
    'what can you do?',
    '',
    'hiking',
  ])('%j is not a greeting', text => {
    expect(isGreeting(text)).toBe(false);
  });

  test("the greeting reply says hello and lists the commands, without a D'oh", () => {
    const text = greetingGuide(names);
    expect(text.startsWith("Hi! I'm Zaplie.")).toBe(true);
    expect(text).not.toContain("D'oh");
    for (const name of names) expect(text).toContain(`- **${name}**`);
  });

  test("the assistant-unavailable reply says it can't chat and lists the commands, without a D'oh", () => {
    const text = assistantUnavailableGuide(names);
    expect(text.startsWith("I can't chat right now")).toBe(true);
    expect(text).not.toContain("D'oh");
    for (const name of names) expect(text).toContain(`- **${name}**`);
    const lines = text.split('\n');
    expect(lines[lines.length - 3]).toBe('- **show leaderboard**');
    expect(lines[lines.length - 2]).toBe('');
    expect(lines[lines.length - 1]).toBe(
      'Type one of those, or ask me again in a few minutes.',
    );
  });
});
