// filepath: /c:/projects/ZapVibes/tabs/backend/server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const authMiddleware = require('./authMiddleware'); // Import the authentication middleware
const identityRoutes = require('./identityRoutes');
const pendingRewardsStore = require('./pendingRewardsStore');
const {
  DEFAULT_REWARD_AMOUNTS,
  migrateRewardAmounts,
  validateRewardAmountPatch,
} = require('./rewardAmounts');

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// Mounted before the generic authMiddleware below: its user-facing routes
// (authorize-url, mine) authenticate with a real MSAL token, not the
// shared backend token, and /resolve applies authMiddleware itself.
app.use('/api/identities', identityRoutes);

// Same reason: user-facing routes here authenticate with a real MSAL token
// (admin writes additionally require the Zaplie.Admin app role), and
// /connections/github/setup is GitHub's post-install browser redirect.
app.use('/api/connections', require('./connectionsRoutes'));
app.use('/api/webhook-keys', require('./webhookKeysRoutes'));
app.use('/api/automations-stats', require('./automationsStatsRoutes'));
app.use('/api/reports', require('./reportsRoutes'));

const { requireAdmin } = require('./adminAuth');
const { requireSignedInOrBot } = require('./readAuth');

const defaultRewardAmounts = DEFAULT_REWARD_AMOUNTS;

const dataFilePath = path.join(__dirname, 'data.json');

// Function to read data from the JSON file
const readData = () => {
  try {
    const data = fs.readFileSync(dataFilePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading data file:', error);
    return { rewardName: 'sats' }; // Default reward name
  }
};

// Function to write data to the JSON file
const writeData = (data) => {
  try {
    fs.writeFileSync(dataFilePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Error writing data file:', error);
    return false;
  }
};

// Admin config writes are registered before the shared-token authMiddleware:
// they authenticate with the caller's MSAL idToken + Zaplie.Admin app role.
app.post('/api/automations', requireAdmin, (req, res) => {
  const { repos } = req.body;
  if (Array.isArray(repos) && repos.every((repo) => typeof repo === 'string' && repo.length > 0)) {
    const data = readData();
    data.automations = { repos };
    if (!writeData(data)) {
      res.status(500).send({ message: 'Automations could not be persisted' });
      return;
    }
    res.send({ message: 'Automations updated successfully', repos: data.automations.repos });
  } else {
    res.status(400).send({ message: 'Invalid repos' });
  }
});

app.post('/api/reward-amounts', requireAdmin, (req, res) => {
  const { rewardAmounts } = req.body || {};
  const validation = validateRewardAmountPatch(rewardAmounts);
  if (!validation.valid) {
    res
      .status(validation.configurationError ? 500 : 400)
      .send({ message: validation.message });
    return;
  }

  const data = readData();
  let storedRewardAmounts;
  try {
    storedRewardAmounts = migrateRewardAmounts(data.rewardAmounts);
  } catch (error) {
    res.status(500).send({
      message: `Stored reward amounts are invalid: ${error.message}`,
    });
    return;
  }
  const nextRewardAmounts = {
    ...defaultRewardAmounts,
    ...storedRewardAmounts,
    ...rewardAmounts,
  };
  const storedValidation = validateRewardAmountPatch(nextRewardAmounts);
  if (!storedValidation.valid) {
    res.status(500).send({
      message: `Stored reward amounts are invalid: ${storedValidation.message}`,
    });
    return;
  }

  data.rewardAmounts = nextRewardAmounts;
  if (!writeData(data)) {
    res.status(500).send({ message: 'Reward amounts could not be persisted' });
    return;
  }
  res.send({
    message: 'Reward amounts updated successfully',
    rewardAmounts: data.rewardAmounts,
  });
});

// Config reads sit before the shared-token middleware because the browser
// cannot hold that secret. reward-name is deliberately open: the portal reads
// it before sign-in and blocks rendering on it. The other two disclose
// connected repositories and payout policy, so they take either a verified
// MSAL token or the bot's shared token.
// Endpoint to get the reward name
app.get('/api/reward-name', (req, res) => {
  const data = readData();
  res.send({ rewardName: data.rewardName });
});

// Endpoint to get the connected repository allowlist
app.get('/api/automations', requireSignedInOrBot, (req, res) => {
  const data = readData();
  res.send({ repos: data.automations?.repos || [] });
});

// Endpoint to get automation reward amounts
app.get('/api/reward-amounts', requireSignedInOrBot, (req, res) => {
  const data = readData();
  try {
    const storedRewardAmounts = migrateRewardAmounts(data.rewardAmounts);
    const rewardAmounts = { ...defaultRewardAmounts, ...storedRewardAmounts };
    const validation = validateRewardAmountPatch(rewardAmounts);
    if (!validation.valid) {
      throw new Error(validation.message);
    }
    res.send({ rewardAmounts });
  } catch (error) {
    res.status(500).send({
      message: `Stored reward amounts are invalid: ${error.message}`,
    });
  }
});

app.post('/api/reward-name', requireAdmin, (req, res) => {
  const { newRewardName } = req.body;
  if (newRewardName) {
    const data = readData();
    data.rewardName = newRewardName;
    if (!writeData(data)) {
      res.status(500).send({ message: 'Reward name could not be persisted' });
      return;
    }
    res.send({ message: 'Reward name updated successfully', rewardName: data.rewardName });
  } else {
    res.status(400).send({ message: 'Invalid reward name' });
  }
});

// Use the authentication middleware for API routes
app.use('/api', authMiddleware);

// Endpoint to update the reward name

// Endpoint the bot posts to when a reward's recipient can't be resolved to a
// Zaplie person yet (identity graph and env-map fallback both miss).
app.post('/api/pending-rewards', (req, res) => {
  const { provider, providerId, recipientLabel, amountSats, reason, source } = req.body || {};
  if (
    typeof provider !== 'string' ||
    typeof providerId !== 'string' ||
    typeof recipientLabel !== 'string' ||
    typeof amountSats !== 'number' ||
    typeof reason !== 'string' ||
    typeof source !== 'string'
  ) {
    res.status(400).send({ message: 'Invalid pending reward payload' });
    return;
  }
  pendingRewardsStore.addPendingReward({
    provider,
    providerId,
    recipientLabel,
    amountSats,
    reason,
    source,
  });
  res.status(201).send({ message: 'Pending reward recorded' });
});

// Serve the React app
app.use(express.static(path.join(__dirname, '../build')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../build', 'index.html'));
});

// Only listen when run directly, so tests can bind an ephemeral port.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });
}

module.exports = app;
