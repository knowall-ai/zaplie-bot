// A strict data.json reader for anything that acts on money. Only a file that
// does not exist yet is an empty store; a corrupt or unreadable file (bad JSON,
// EIO on the data share, EACCES) throws. Read as "no settings", the allowance
// policy would be a disabled one, and the timer would pause every schedule on
// the Fund wallet. The config routes keep their lax reader in server.js.
const fs = require('fs');

// `filePath` may be a function, resolved on every read, so the path follows
// the current organisation (dataPaths.js).
const readDataStrict = filePath => () => {
  const resolved = typeof filePath === 'function' ? filePath() : filePath;
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
};

module.exports = { readDataStrict };
