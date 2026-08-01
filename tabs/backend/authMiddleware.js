const { createHash, timingSafeEqual } = require('crypto');

const PLACEHOLDER = 'your-secret-token';

// Resolved once at load: a missing secret must stop the server from starting,
// not turn every authenticated request into a 500.
const expectedToken = (() => {
  const token = process.env.TAB_BACKEND_TOKEN;
  if (!token || token === PLACEHOLDER) {
    throw new Error(
      'TAB_BACKEND_TOKEN is not set to a real value. Generate one with `openssl rand -hex 32`.',
    );
  }
  return token;
})();

// timingSafeEqual throws when the buffers differ in length, so comparing the
// received token directly turns a wrong-length token into a crash. SHA-256
// digests are always 32 bytes.
const digest = value => createHash('sha256').update(String(value)).digest();

const authMiddleware = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  if (!timingSafeEqual(digest(token), digest(expectedToken))) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  next();
};

module.exports = authMiddleware;
