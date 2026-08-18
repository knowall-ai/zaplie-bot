const fs = require('fs');
const path = require('path');

const getDataDir = () => {
  const configured = process.env.ZAPLIE_DATA_DIR;
  return configured ? path.resolve(configured) : __dirname;
};

const ensureDataDir = () => {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return dataDir;
};

const dataPath = (filename) => path.join(getDataDir(), filename);

module.exports = { dataPath, ensureDataDir, getDataDir };
