const { extractBearerToken, verifyMsalAccessToken } = require('./msalValidator');

const ADMIN_ROLE = 'Zaplie.Admin';

const requireAdmin = async (req, res, next) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).send({ message: 'Missing bearer token' });
    return;
  }

  try {
    const { roles } = await verifyMsalAccessToken(token);
    if (!roles.includes(ADMIN_ROLE)) {
      res.status(403).send({ message: `${ADMIN_ROLE} role required` });
      return;
    }
    next();
  } catch (error) {
    console.error('MSAL access token validation failed:', error.message);
    res.status(401).send({ message: 'Invalid bearer token' });
  }
};

module.exports = { ADMIN_ROLE, requireAdmin };
