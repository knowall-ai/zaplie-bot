// filepath: tabs/backend/adminAuth.js
// Org configuration writes require the Entra app role "Zaplie.Admin", carried
// in the verified idToken's roles claim (assigned per user in Entra ID).
const { verifyMsalClaims, extractBearerToken } = require('./msalValidator');

const ADMIN_ROLE = 'Zaplie.Admin';

const requireAdmin = async (req, res, next) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    const { roles } = await verifyMsalClaims(token);
    if (!roles.includes(ADMIN_ROLE)) {
      res.status(403).json({ error: `${ADMIN_ROLE} role required` });
      return;
    }
    next();
  } catch (error) {
    console.error('MSAL token validation failed:', error.message);
    res.status(401).json({ error: 'invalid token' });
  }
};

module.exports = { requireAdmin, ADMIN_ROLE };
