// filepath: /c:/projects/ZapVibes/tabs/backend/server.js
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const authMiddleware = require('./authMiddleware'); // Import the authentication middleware
const internalAuthMiddleware = require('./internalAuthMiddleware');
const identityRoutes = require('./identityRoutes');
const pendingRewardsStore = require('./pendingRewardsStore');

const app = express();
const port = process.env.PORT || 5000;

const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(cors());
// Apply abuse protection before any API route performs authentication, file
// access, or outbound requests. Static assets remain outside this budget.
app.use('/api', apiRateLimiter);
app.use(bodyParser.json());

// Mounted before the generic authMiddleware below: its user-facing routes
// (authorize-url, mine) authenticate with a real MSAL token, not the
// shared backend token, and /resolve applies internalAuthMiddleware itself.
app.use('/api/identities', identityRoutes);

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

// The bot writes an unresolved reward with the server-only shared token. This
// route must stay before the legacy browser middleware below.
app.post('/api/pending-rewards', internalAuthMiddleware, (req, res) => {
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

// Legacy browser routes still use the pre-existing placeholder middleware.
// TAB_BACKEND_TOKEN is intentionally not accepted here because browser clients
// must never receive it. Migrating these routes to MSAL + roles is separate.
app.use('/api', authMiddleware);

// Endpoint to get the reward name
app.get('/api/reward-name', (req, res) => {
  const data = readData();
  res.send({ rewardName: data.rewardName });
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

// Serve the React app
app.use(express.static(path.join(__dirname, '../build')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../build', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
