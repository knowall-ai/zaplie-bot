const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-data-paths-'));
process.env.ZAPLIE_DATA_DIR = tempDir;

const { dataPath, getDataDir } = require('./dataPaths');
const { setInstallation, getInstallation } = require('./connectionsStore');

after(() => {
  delete process.env.ZAPLIE_DATA_DIR;
  const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(path.resolve(tempDir).startsWith(safePrefix), true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('mutable stores honor ZAPLIE_DATA_DIR and create it when needed', () => {
  assert.equal(getDataDir(), tempDir);
  assert.equal(dataPath('connections.json'), path.join(tempDir, 'connections.json'));

  setInstallation('aad-1', 'installation-1');

  assert.equal(getInstallation('aad-1'), 'installation-1');
  assert.equal(fs.existsSync(path.join(tempDir, 'connections.json')), true);
});
