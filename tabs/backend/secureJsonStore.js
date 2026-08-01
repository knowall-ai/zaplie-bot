// The mode argument of fs.writeFileSync only applies when the call creates the
// file, and these stores rewrite files that already exist. Writing to a fresh
// temporary file and renaming it over the target applies the mode for real and
// makes the replacement atomic, so a crash mid-write cannot truncate the store.
const fs = require('fs');

const writeJsonSecure = (filePath, data) => {
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

module.exports = { writeJsonSecure };
