const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_MAX_REWARD_SATS = 10000;
const DEFAULT_ADMIN_CONFIG = Object.freeze({
  rewardName: 'sats',
  botPersona: '',
  rewardAmounts: Object.freeze({ githubPrMergedSats: 1000 }),
});

const allowsRepositoryFallback = (environment) =>
  environment.RUNNING_ON_AZURE !== '1'
  && ['development', 'test'].includes(environment.NODE_ENV);

const resolveDataFilePath = (environment = process.env) => {
  const configuredPath = environment.ZAPLIE_CONFIG_FILE?.trim();
  if (!configuredPath) {
    if (allowsRepositoryFallback(environment)) {
      return path.join(__dirname, 'data.json');
    }
    throw new Error(
      'ZAPLIE_CONFIG_FILE must point to persistent writable storage outside development and test',
    );
  }

  if (!allowsRepositoryFallback(environment) && !path.isAbsolute(configuredPath)) {
    throw new Error(
      'ZAPLIE_CONFIG_FILE must be an absolute path outside development and test',
    );
  }
  return path.resolve(configuredPath);
};

const resolveMaxRewardSats = (environment = process.env) => {
  const configured = environment.REWARDS_MAX_AMOUNT_SATS?.trim();
  if (!configured) {
    return DEFAULT_MAX_REWARD_SATS;
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('REWARDS_MAX_AMOUNT_SATS must be a positive safe integer');
  }
  return value;
};

const seedDataFileIfMissing = (filePath, seed = DEFAULT_ADMIN_CONFIG) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let descriptor;
  let created = false;

  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return true;
  } catch (error) {
    if (!created && error.code === 'EEXIST') {
      return false;
    }
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original seed failure.
      }
    }
    if (created) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Preserve the original seed failure.
      }
    }
    throw error;
  }
};

const createAdminConfigStore = ({
  filePath = resolveDataFilePath(),
  maxRewardSats = resolveMaxRewardSats(),
} = {}) => {
  seedDataFileIfMissing(filePath);

  const readData = () => {
    const serialized = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(serialized);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Config data must be a JSON object');
    }
    return data;
  };

  const readAdminConfig = (data) => {
    if (typeof data.rewardName !== 'string' || data.rewardName.trim().length === 0) {
      throw new Error('Stored reward name is invalid');
    }
    if (data.botPersona !== undefined && typeof data.botPersona !== 'string') {
      throw new Error('Stored bot persona is invalid');
    }

    const storedAmount = data.rewardAmounts?.githubPrMergedSats;
    const githubPrMergedSats = storedAmount === undefined
      ? DEFAULT_ADMIN_CONFIG.rewardAmounts.githubPrMergedSats
      : storedAmount;
    if (
      !Number.isSafeInteger(githubPrMergedSats)
      || githubPrMergedSats <= 0
      || githubPrMergedSats > maxRewardSats
    ) {
      throw new Error('Stored GitHub reward amount is invalid');
    }

    return {
      rewardName: data.rewardName,
      botPersona: data.botPersona || '',
      rewardAmounts: { githubPrMergedSats },
    };
  };

  const validateAdminConfig = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }

    const { rewardName, botPersona, rewardAmounts } = body;
    if (
      typeof rewardName !== 'string'
      || rewardName.trim().length === 0
      || rewardName.trim().length > 40
      || typeof botPersona !== 'string'
      || botPersona.trim().length > 4000
      || !rewardAmounts
      || typeof rewardAmounts !== 'object'
      || Array.isArray(rewardAmounts)
      || Object.keys(rewardAmounts).length !== 1
      || !Object.prototype.hasOwnProperty.call(rewardAmounts, 'githubPrMergedSats')
      || !Number.isSafeInteger(rewardAmounts.githubPrMergedSats)
      || rewardAmounts.githubPrMergedSats <= 0
      || rewardAmounts.githubPrMergedSats > maxRewardSats
    ) {
      return null;
    }

    return {
      rewardName: rewardName.trim(),
      botPersona: botPersona.trim(),
      rewardAmounts: { githubPrMergedSats: rewardAmounts.githubPrMergedSats },
    };
  };

  const writeDataAtomic = (data) => {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor;

    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // Preserve the original write failure.
        }
      }
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created or may already be gone.
      }
      throw error;
    }
  };

  // Validate persisted state at startup rather than serving a partially broken API.
  readAdminConfig(readData());

  return {
    filePath,
    maxRewardSats,
    readData,
    readAdminConfig,
    validateAdminConfig,
    writeDataAtomic,
  };
};

module.exports = {
  DEFAULT_ADMIN_CONFIG,
  DEFAULT_MAX_REWARD_SATS,
  createAdminConfigStore,
  resolveDataFilePath,
  resolveMaxRewardSats,
  seedDataFileIfMissing,
};
