// The mode argument of fs.writeFileSync only applies when the call creates the
// file, and these stores rewrite files that already exist. Writing to a fresh
// temporary file and renaming it over the target applies the mode for real and
// makes the replacement atomic, so a crash mid-write cannot truncate the store.
const fs = require('fs');
const path = require('path');

const ensureSecureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync applies the mode only when it creates the directory, so an
  // existing store would keep whatever permissions it was given. Windows has no
  // POSIX mode to correct, so the check there would fire on every write.
  if (process.platform === 'win32') {
    return;
  }
  if ((fs.statSync(dir).mode & 0o777) !== 0o700) {
    fs.chmodSync(dir, 0o700);
  }
};

const writeJsonSecure = (filePath, data) => {
  ensureSecureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw error;
  }
};

module.exports = { ensureSecureDir, writeJsonSecure };
