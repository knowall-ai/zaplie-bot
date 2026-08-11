// filepath: /c:/projects/ZapVibes/tabs/backend/server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { requireAdmin } = require('./adminAuth');

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const dataFilePath = process.env.ZAPLIE_CONFIG_FILE || path.join(__dirname, 'data.json');
const defaultRewardAmounts = { githubPrMergedSats: 1000 };

const readData = () => {
  const serialized = fs.readFileSync(dataFilePath, 'utf8');
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
    ? defaultRewardAmounts.githubPrMergedSats
    : storedAmount;
  if (!Number.isSafeInteger(githubPrMergedSats) || githubPrMergedSats <= 0) {
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
  const temporaryPath = `${dataFilePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;

  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, dataFilePath);
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

// The reward label is needed before the portal completes sign-in. It contains
// no administrative policy; every configuration write remains protected.
app.get('/api/reward-name', (req, res) => {
  try {
    const { rewardName } = readAdminConfig(readData());
    res.send({ rewardName });
  } catch (error) {
    console.error('Unable to read reward name:', error.message);
    res.status(500).send({ message: 'Unable to read reward name' });
  }
});

app.get('/api/admin-config', requireAdmin, (req, res) => {
  try {
    res.send({ config: readAdminConfig(readData()) });
  } catch (error) {
    console.error('Unable to read admin config:', error.message);
    res.status(500).send({ message: 'Unable to read admin config' });
  }
});

app.put('/api/admin-config', requireAdmin, (req, res) => {
  const config = validateAdminConfig(req.body);
  if (!config) {
    res.status(400).send({ message: 'Invalid admin config' });
    return;
  }

  try {
    const currentData = readData();
    const nextData = {
      ...currentData,
      rewardName: config.rewardName,
      botPersona: config.botPersona,
      rewardAmounts: {
        ...currentData.rewardAmounts,
        ...config.rewardAmounts,
      },
    };
    writeDataAtomic(nextData);
    res.send({ config: readAdminConfig(nextData) });
  } catch (error) {
    console.error('Unable to save admin config:', error.message);
    res.status(500).send({ message: 'Unable to save admin config' });
  }
});

app.use(express.static(path.join(__dirname, '../build')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../build', 'index.html'));
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });
}

module.exports = app;
