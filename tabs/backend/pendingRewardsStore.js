// filepath: tabs/backend/pendingRewardsStore.js
// Rewards whose recipient couldn't be resolved to a Zaplie person yet.
// Gitignored — see pending-rewards.json. Claiming/invitation is Phase 2.
const fs = require('fs');
const { dataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');

// Resolved per call: each organisation has its own file (dataPaths.js).
const storePath = () => dataPath('pending-rewards.json');

const readStore = () => {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { pendingRewards: [] };
    }
    throw error;
  }
};

const writeStore = (store) => {
  writeJsonSecure(storePath(), store);
};

const addPendingReward = (pending) => {
  const store = readStore();
  store.pendingRewards.push({ ...pending, createdAt: new Date().toISOString() });
  writeStore(store);
};

const listPendingRewards = () => readStore().pendingRewards;

module.exports = { addPendingReward, listPendingRewards };
