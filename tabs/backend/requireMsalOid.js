// filepath: tabs/backend/requireMsalOid.js
// Resolves the caller's Entra oid from a verified MSAL ID token, or answers
// 401 and returns null. Shared by the user-facing GitHub routes (identity
// linking and repository connections), which must never take an oid from the
// client.
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');

const requireMsalOid = async (req, res) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return null;
  }
  try {
    return await verifyMsalToken(token);
  } catch (error) {
    console.error('MSAL token validation failed:', error.message);
    res.status(401).json({ error: 'invalid token' });
    return null;
  }
};

module.exports = { requireMsalOid };
