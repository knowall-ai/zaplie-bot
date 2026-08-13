// Config reads have two legitimate callers with different credentials: the
// portal, which holds a signed-in user's MSAL token, and the bot, which holds
// the shared TAB_BACKEND_TOKEN. The browser cannot hold the shared secret, so
// accepting either is what keeps these endpoints closed without breaking the
// portal. Replacing the ID token with a proper access token for this API is
// tracked in #184.
const { createHash, timingSafeEqual } = require('crypto');
const { verifyMsalPayload, extractBearerToken } = require('./msalValidator');

const PLACEHOLDER = 'your-secret-token';

const expectedToken = (() => {
  const token = process.env.TAB_BACKEND_TOKEN;
  if (!token || token === PLACEHOLDER) {
    throw new Error(
      'TAB_BACKEND_TOKEN is not set to a real value. Generate one with `openssl rand -hex 32`.',
    );
  }
  return token;
})();

const digest = value => createHash('sha256').update(String(value)).digest();

const requireSignedInOrBot = async (req, res, next) => {
  const header = req.headers['authorization'];
  if (!header) {
    res.status(401).json({ error: 'missing credentials' });
    return;
  }

  const bearer = extractBearerToken(req);
  if (bearer) {
    try {
      await verifyMsalPayload(bearer);
      next();
      return;
    } catch (error) {
      console.error('MSAL token validation failed:', error.message);
      res.status(401).json({ error: 'invalid token' });
      return;
    }
  }

  if (timingSafeEqual(digest(header), digest(expectedToken))) {
    next();
    return;
  }

  res.status(401).json({ error: 'invalid token' });
};

module.exports = { requireSignedInOrBot };
