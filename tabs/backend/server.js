// filepath: /c:/projects/ZapVibes/tabs/backend/server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const { requireAdmin } = require('./adminAuth');
const { createAdminConfigStore } = require('./adminConfigStore');

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const {
  readData,
  readAdminConfig,
  validateAdminConfig,
  writeDataAtomic,
} = createAdminConfigStore();

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
