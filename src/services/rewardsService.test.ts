import { parseRewardRequest, resolveAmountSats, RewardError } from './rewardsService';
import { getRewardAmounts } from './fetchRewardAmounts';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('./fetchRewardAmounts');

const mockedGetRewardAmounts = getRewardAmounts as jest.MockedFunction<
  typeof getRewardAmounts
>;

const validReward = {
  recipient: 'octocat',
  recipientId: '583231',
  eventType: 'githubPrMerged',
  repo: 'octo-org/octo-repo',
  reason: 'GitHub: PR #7 merged',
  source: 'github' as const,
};

describe('parseRewardRequest', () => {
  test('returns the normalized GitHub reward payload', () => {
    expect(parseRewardRequest(validReward)).toEqual(validReward);
    expect(
      parseRewardRequest({ ...validReward, recipientId: 583231 }),
    ).toEqual(validReward);
  });

  test.each([
    ['missing recipient', { ...validReward, recipient: undefined }],
    ['empty recipient', { ...validReward, recipient: '' }],
    ['whitespace recipient', { ...validReward, recipient: '  ' }],
    ['non-string recipient', { ...validReward, recipient: 42 }],
    ['missing recipientId', { ...validReward, recipientId: undefined }],
    ['empty recipientId', { ...validReward, recipientId: '' }],
    ['whitespace recipientId', { ...validReward, recipientId: '  ' }],
    ['non-numeric recipientId', { ...validReward, recipientId: 'octocat' }],
    ['zero recipientId', { ...validReward, recipientId: 0 }],
    ['negative recipientId', { ...validReward, recipientId: -1 }],
    ['fractional recipientId', { ...validReward, recipientId: 1.5 }],
    ['missing eventType', { ...validReward, eventType: undefined }],
    ['empty eventType', { ...validReward, eventType: '' }],
    ['non-GitHub eventType', { ...validReward, eventType: 'timesheetWeek' }],
    [
      'unknown GitHub eventType',
      { ...validReward, eventType: 'githubCoffeeBreak' },
    ],
    ['missing repo', { ...validReward, repo: undefined }],
    ['empty repo', { ...validReward, repo: '' }],
    ['malformed repo', { ...validReward, repo: 'octo-repo' }],
    ['missing reason', { ...validReward, reason: undefined }],
    ['empty reason', { ...validReward, reason: '  ' }],
    ['non-string reason', { ...validReward, reason: 42 }],
    ['missing source', { ...validReward, source: undefined }],
    ['non-GitHub source', { ...validReward, source: 'timesheet' }],
    ['caller-supplied amount', { ...validReward, amountSats: 21 }],
    ['null body', null],
  ])('rejects %s with a 400', (_label, body) => {
    expect(() => parseRewardRequest(body)).toThrow(RewardError);
    try {
      parseRewardRequest(body);
    } catch (error) {
      expect((error as RewardError).statusCode).toBe(400);
    }
  });
});

describe('resolveAmountSats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('resolves eventType against the configured reward amounts', async () => {
    mockedGetRewardAmounts.mockResolvedValue({ githubPrMergedSats: 777 });

    await expect(
      resolveAmountSats(parseRewardRequest(validReward)),
    ).resolves.toBe(777);
  });

  test('rejects a retired event even when stale config still contains it', () => {
    mockedGetRewardAmounts.mockResolvedValue({ timesheetWeekSats: 800 });

    expect(() =>
      parseRewardRequest({ ...validReward, eventType: 'timesheetWeek' }),
    ).toThrow(RewardError);
    expect(mockedGetRewardAmounts).not.toHaveBeenCalled();
  });

  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'rejects a prototype-pollution eventType "%s" before reading config',
    eventType => {
      expect(() => parseRewardRequest({ ...validReward, eventType })).toThrow(
        RewardError,
      );
      expect(mockedGetRewardAmounts).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['NaN', Number.NaN],
    ['negative', -50],
    ['zero', 0],
    ['fractional', 12.5],
    ['above the cap', 20000],
  ])(
    'fails closed when the configured amount is %s',
    async (_label, configuredAmount) => {
      mockedGetRewardAmounts.mockResolvedValue({
        githubPrMergedSats: configuredAmount,
      });

      await expect(
        resolveAmountSats(parseRewardRequest(validReward)),
      ).rejects.toThrow('configured amount');
    },
  );

  test('propagates a config fetch rejection', async () => {
    mockedGetRewardAmounts.mockRejectedValue(new Error('backend unreachable'));

    await expect(
      resolveAmountSats(parseRewardRequest(validReward)),
    ).rejects.toThrow('backend unreachable');
  });
});
