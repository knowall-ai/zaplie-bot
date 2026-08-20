const path = require('path');
const { ensureSecureDir } = require('./secureJsonStore');

const getDataDir = () => {
  const configured = process.env.ZAPLIE_DATA_DIR;
  return configured ? path.resolve(configured) : __dirname;
};

const ensureDataDir = () => {
  const dataDir = getDataDir();
  ensureSecureDir(dataDir);
  return dataDir;
};

const dataPath = (filename) => path.join(getDataDir(), filename);

module.exports = { dataPath, ensureDataDir, getDataDir };
