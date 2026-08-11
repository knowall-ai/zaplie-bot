const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_REWARD_AMOUNTS,
  maxRewardSats,
  validateRewardAmountPatch,
} = require('./rewardAmounts');

const originalCap = process.env.REWARDS_MAX_AMOUNT_SATS;

test.afterEach(() => {
  if (originalCap === undefined) {
    delete process.env.REWARDS_MAX_AMOUNT_SATS;
  } else {
    process.env.REWARDS_MAX_AMOUNT_SATS = originalCap;
  }
});

test('accepts known reward rules with positive integer values', () => {
  assert.deepEqual(
    validateRewardAmountPatch({ githubPrMergedSats: 750 }),
    { valid: true },
  );
});

test('rejects malformed, unknown and unsafe reward amounts', async (t) => {
  const invalidCases = [
    [null, 'rewardAmounts must be an object'],
    [[], 'rewardAmounts must be an object'],
    [{}, 'rewardAmounts must include at least one reward rule'],
    [{ unexpectedRuleSats: 100 }, 'Unknown reward rule: unexpectedRuleSats'],
    [{ githubPrMergedSats: '100' }, 'githubPrMergedSats must be a positive integer'],
    [{ githubPrMergedSats: Number.NaN }, 'githubPrMergedSats must be a positive integer'],
    [{ githubPrMergedSats: -1 }, 'githubPrMergedSats must be a positive integer'],
    [{ githubPrMergedSats: 1.5 }, 'githubPrMergedSats must be a positive integer'],
    [{ githubPrMergedSats: 10001 }, 'githubPrMergedSats exceeds the per-reward cap of 10000'],
  ];

  for (const [value, message] of invalidCases) {
    await t.test(message, () => {
      assert.deepEqual(validateRewardAmountPatch(value), { valid: false, message });
    });
  }
});

test('uses and validates the configured reward cap', () => {
  process.env.REWARDS_MAX_AMOUNT_SATS = '250';
  assert.equal(maxRewardSats(), 250);
  assert.deepEqual(
    validateRewardAmountPatch({ timesheetWeekSats: 251 }),
    {
      valid: false,
      message: 'timesheetWeekSats exceeds the per-reward cap of 250',
    },
  );

  process.env.REWARDS_MAX_AMOUNT_SATS = 'not-a-number';
  assert.deepEqual(validateRewardAmountPatch(DEFAULT_REWARD_AMOUNTS), {
    valid: false,
    message: 'REWARDS_MAX_AMOUNT_SATS must be a positive integer',
    configurationError: true,
  });
});
