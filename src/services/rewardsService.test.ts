import { parseRewardRequest, resolveAmountSats, RewardError } from './rewardsService';
import { getRewardAmounts } from './fetchRewardAmounts';
import { expect, describe, test, beforeEach, jest } from '@jest/globals';

jest.mock('./fetchRewardAmounts');

const mockedGetRewardAmounts = getRewardAmounts as jest.MockedFunction<
  typeof getRewardAmounts
>;

const validReward = {
  recipient: 'octocat',
  amountSats: 210,
  reason: 'GitHub: PR #7 merged',
  source: 'github',
};

describe('parseRewardRequest', () => {
  test('returns the parsed reward for a valid payload', () => {
    expect(parseRewardRequest(validReward)).toEqual(validReward);
  });

  test.each([
    ['missing recipient', { ...validReward, recipient: undefined }],
    ['empty recipient', { ...validReward, recipient: '' }],
    ['missing amountSats', { ...validReward, amountSats: undefined }],
    ['zero amountSats', { ...validReward, amountSats: 0 }],
    ['negative amountSats', { ...validReward, amountSats: -5 }],
    ['fractional amountSats', { ...validReward, amountSats: 1.5 }],
    ['string amountSats', { ...validReward, amountSats: '100' }],
    ['missing reason', { ...validReward, reason: undefined }],
    ['missing source', { ...validReward, source: undefined }],
    ['null body', null],
    ['amountSats above the default cap', { ...validReward, amountSats: 10001 }],
  ])('rejects %s with a 400', (_label, body) => {
    expect(() => parseRewardRequest(body)).toThrow(RewardError);
    try {
      parseRewardRequest(body);
    } catch (error) {
      expect((error as RewardError).statusCode).toBe(400);
    }
  });
});

describe('parseRewardRequest cap', () => {
  test('accepts amounts up to the default cap and honours REWARDS_MAX_AMOUNT_SATS', () => {
    expect(parseRewardRequest({ ...validReward, amountSats: 10000 }).amountSats).toBe(10000);

    process.env.REWARDS_MAX_AMOUNT_SATS = '500';
    expect(() => parseRewardRequest({ ...validReward, amountSats: 501 })).toThrow(
      'per-reward cap of 500',
    );
    delete process.env.REWARDS_MAX_AMOUNT_SATS;
  });
});

describe('parseRewardRequest eventType', () => {
  test('accepts a payload with eventType and no amountSats', () => {
    const { amountSats: _omit, ...withoutAmount } = validReward;
    const parsed = parseRewardRequest({
      ...withoutAmount,
      eventType: 'githubPrMerged',
    });
    expect(parsed.amountSats).toBeUndefined();
    expect(parsed.eventType).toBe('githubPrMerged');
  });

  test('rejects a payload missing both amountSats and eventType', () => {
    const { amountSats: _omit, ...withoutAmount } = validReward;
    expect(() => parseRewardRequest(withoutAmount)).toThrow(
      'either amountSats or eventType is required',
    );
  });
});

describe('resolveAmountSats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns amountSats unchanged and never consults the config', async () => {
    const request = parseRewardRequest(validReward);
    await expect(resolveAmountSats(request)).resolves.toBe(210);
    expect(mockedGetRewardAmounts).not.toHaveBeenCalled();
  });

  test('resolves eventType against the configured reward amounts', async () => {
    mockedGetRewardAmounts.mockResolvedValue({ githubPrMergedSats: 777 });
    const { amountSats: _omit, ...withoutAmount } = validReward;
    const request = parseRewardRequest({
      ...withoutAmount,
      eventType: 'githubPrMerged',
    });

    await expect(resolveAmountSats(request)).resolves.toBe(777);
  });

  test('rejects an unknown eventType with a 400 and the exact message', async () => {
    mockedGetRewardAmounts.mockResolvedValue({ githubPrMergedSats: 777 });
    const { amountSats: _omit, ...withoutAmount } = validReward;
    const request = parseRewardRequest({
      ...withoutAmount,
      eventType: 'coffeeBreak',
    });

    await expect(resolveAmountSats(request)).rejects.toThrow(
      "no configured amount for eventType 'coffeeBreak'",
    );
    await expect(resolveAmountSats(request)).rejects.toHaveProperty(
      'statusCode',
      400,
    );
  });

  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'rejects a prototype-pollution eventType "%s" with a 400 and never resolves',
    async eventTypeValue => {
      mockedGetRewardAmounts.mockResolvedValue({ githubPrMergedSats: 777 });
      const { amountSats: _omit, ...withoutAmount } = validReward;
      const request = parseRewardRequest({
        ...withoutAmount,
        eventType: eventTypeValue,
      });

      await expect(resolveAmountSats(request)).rejects.toHaveProperty(
        'statusCode',
        400,
      );
    },
  );

  test.each([
    ['NaN', NaN],
    ['negative', -50],
    ['zero', 0],
    ['fractional', 12.5],
    ['above the cap', 20000],
  ])(
    'throws a plain Error when the configured amount is %s',
    async (_label, configuredAmount) => {
      mockedGetRewardAmounts.mockResolvedValue({
        githubPrMergedSats: configuredAmount,
      });
      const { amountSats: _omit, ...withoutAmount } = validReward;
      const request = parseRewardRequest({
        ...withoutAmount,
        eventType: 'githubPrMerged',
      });

      await expect(resolveAmountSats(request)).rejects.not.toBeInstanceOf(
        RewardError,
      );
      await expect(resolveAmountSats(request)).rejects.toThrow(
        'configured amount',
      );
    },
  );

  test('propagates a config fetch rejection', async () => {
    mockedGetRewardAmounts.mockRejectedValue(new Error('backend unreachable'));
    const { amountSats: _omit, ...withoutAmount } = validReward;
    const request = parseRewardRequest({
      ...withoutAmount,
      eventType: 'githubPrMerged',
    });

    await expect(resolveAmountSats(request)).rejects.toThrow(
      'backend unreachable',
    );
  });
});
