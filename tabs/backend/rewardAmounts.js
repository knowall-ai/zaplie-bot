const DEFAULT_REWARD_AMOUNTS = Object.freeze({
  githubPrMergedSats: 1000,
  githubIssueClosedSats: 500,
  githubReviewSubmittedSats: 300,
});

const DEFAULT_MAX_REWARD_SATS = 10000;
const DEPRECATED_REWARD_AMOUNT_KEYS = new Set(['timesheetWeekSats']);

const migrateRewardAmounts = (rewardAmounts) => {
  if (rewardAmounts === undefined) {
    return {};
  }
  if (!rewardAmounts || typeof rewardAmounts !== 'object' || Array.isArray(rewardAmounts)) {
    throw new Error('Stored rewardAmounts must be an object');
  }
  return Object.fromEntries(
    Object.entries(rewardAmounts).filter(
      ([key]) => !DEPRECATED_REWARD_AMOUNT_KEYS.has(key),
    ),
  );
};

const maxRewardSats = () => {
  const configured = process.env.REWARDS_MAX_AMOUNT_SATS;
  if (configured === undefined || configured === '') {
    return DEFAULT_MAX_REWARD_SATS;
  }
  const value = Number(configured);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('REWARDS_MAX_AMOUNT_SATS must be a positive integer');
  }
  return value;
};

const validateRewardAmountPatch = (rewardAmounts) => {
  if (
    !rewardAmounts ||
    typeof rewardAmounts !== 'object' ||
    Array.isArray(rewardAmounts)
  ) {
    return { valid: false, message: 'rewardAmounts must be an object' };
  }

  const entries = Object.entries(rewardAmounts);
  if (entries.length === 0) {
    return { valid: false, message: 'rewardAmounts must include at least one reward rule' };
  }

  let cap;
  try {
    cap = maxRewardSats();
  } catch (error) {
    return { valid: false, message: error.message, configurationError: true };
  }

  for (const [key, value] of entries) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_REWARD_AMOUNTS, key)) {
      return { valid: false, message: `Unknown reward rule: ${key}` };
    }
    if (!Number.isInteger(value) || value <= 0) {
      return { valid: false, message: `${key} must be a positive integer` };
    }
    if (value > cap) {
      return { valid: false, message: `${key} exceeds the per-reward cap of ${cap}` };
    }
  }

  return { valid: true };
};

module.exports = {
  DEFAULT_REWARD_AMOUNTS,
  migrateRewardAmounts,
  maxRewardSats,
  validateRewardAmountPatch,
};
