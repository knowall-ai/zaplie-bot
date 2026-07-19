// filepath: /c:/projects/ZapVibes/tabs/backend/server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const authMiddleware = require('./authMiddleware'); // Import the authentication middleware
const identityRoutes = require('./identityRoutes');
const pendingRewardsStore = require('./pendingRewardsStore');

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// Mounted before the generic authMiddleware below: its user-facing routes
// (authorize-url, mine) authenticate with a real MSAL token, not the
// placeholder API token, and /resolve applies authMiddleware itself.
app.use('/api/identities', identityRoutes);

// Same reason: user-facing routes here authenticate with a real MSAL token
// (admin writes additionally require the Zaplie.Admin app role), and
// /connections/github/setup is GitHub's post-install browser redirect.
app.use('/api/connections', require('./connectionsRoutes'));
app.use('/api/webhook-keys', require('./webhookKeysRoutes'));
app.use('/api/automations-stats', require('./automationsStatsRoutes'));
app.use('/api/reports', require('./reportsRoutes'));
app.use('/api/setup', require('./setupRoutes'));

const { requireAdmin } = require('./adminAuth');

const defaultRewardAmounts = {
  githubPrMergedSats: 1000,
  githubIssueClosedSats: 500,
  githubReviewSubmittedSats: 300,
  timesheetWeekSats: 800,
};

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
  } catch (error) {
    console.error('Error writing data file:', error);
  }
};

// Admin config writes are registered before the placeholder authMiddleware:
// they authenticate with the caller's MSAL idToken + Zaplie.Admin app role.
app.post('/api/automations', requireAdmin, (req, res) => {
  const { repos } = req.body;
  if (Array.isArray(repos) && repos.every((repo) => typeof repo === 'string' && repo.length > 0)) {
    const data = readData();
    data.automations = { repos };
    writeData(data);
    res.send({ message: 'Automations updated successfully', repos: data.automations.repos });
  } else {
    res.status(400).send({ message: 'Invalid repos' });
  }
});

app.post('/api/reward-amounts', requireAdmin, (req, res) => {
  const { rewardAmounts } = req.body;
  if (rewardAmounts && typeof rewardAmounts === 'object' && !Array.isArray(rewardAmounts)) {
    const data = readData();
    data.rewardAmounts = { ...defaultRewardAmounts, ...data.rewardAmounts, ...rewardAmounts };
    writeData(data);
    res.send({ message: 'Reward amounts updated successfully', rewardAmounts: data.rewardAmounts });
  } else {
    res.status(400).send({ message: 'Invalid reward amounts' });
  }
});

// Use the authentication middleware for API routes
app.use('/api', authMiddleware);

// Endpoint to get the reward name
app.get('/api/reward-name', (req, res) => {
  const data = readData();
  res.send({ rewardName: data.rewardName });
});

// Endpoint to get the connected repository allowlist
app.get('/api/automations', (req, res) => {
  const data = readData();
  res.send({ repos: data.automations?.repos || [] });
});

// Endpoint to get automation reward amounts
app.get('/api/reward-amounts', (req, res) => {
  const data = readData();
  res.send({ rewardAmounts: { ...defaultRewardAmounts, ...data.rewardAmounts } });
});

// Endpoint to update the reward name
app.post('/api/reward-name', (req, res) => {
  const { newRewardName } = req.body;
  if (newRewardName) {
    const data = readData();
    data.rewardName = newRewardName;
    writeData(data);
    res.send({ message: 'Reward name updated successfully', rewardName: data.rewardName });
  } else {
    res.status(400).send({ message: 'Invalid reward name' });
  }
});

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

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});