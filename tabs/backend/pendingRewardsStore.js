// filepath: tabs/backend/pendingRewardsStore.js
// Rewards whose recipient couldn't be resolved to a Zaplie person yet.
// Gitignored — see pending-rewards.json. Claiming/invitation is Phase 2.
const fs = require('fs');
const path = require('path');
const { writeJsonSecure } = require('./secureJsonStore');

const STORE_PATH = path.join(__dirname, 'pending-rewards.json');

const readStore = () => {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { pendingRewards: [] };
    }
    throw error;
  }
};

const writeStore = (store) => {
  writeJsonSecure(STORE_PATH, store);
};

const addPendingReward = (pending) => {
  const store = readStore();
  store.pendingRewards.push({ ...pending, createdAt: new Date().toISOString() });
  writeStore(store);
};

const listPendingRewards = () => readStore().pendingRewards;

module.exports = { addPendingReward, listPendingRewards };
