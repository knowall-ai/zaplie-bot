const { createHash, timingSafeEqual } = require('crypto');

const PLACEHOLDER = 'your-secret-token';

// Resolve once at load so a missing secret stops the backend at startup.
const expectedToken = (() => {
  const token = process.env.TAB_BACKEND_TOKEN;
  if (!token || token === PLACEHOLDER) {
    throw new Error(
      'TAB_BACKEND_TOKEN is not set to a real value. Generate one with `openssl rand -hex 32`.',
    );
  }
  return token;
})();

// Hash first because timingSafeEqual requires equal-length buffers.
const digest = value => createHash('sha256').update(String(value)).digest();

const internalAuthMiddleware = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  if (!timingSafeEqual(digest(token), digest(expectedToken))) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  next();
};

module.exports = internalAuthMiddleware;
