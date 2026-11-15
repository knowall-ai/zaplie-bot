// filepath: tabs/backend/adminAuth.js
// Organisation configuration requires a Zaplie admin of the caller's own
// tenant (adminRoles.js: the Zaplie.Admin app role, or Global Administrator).
// Every store the request then touches is that tenant's (tenantContext.js),
// so an admin of one organisation can never read or change another's.
//
// KnowAll's platform operator may additionally READ another organisation's
// admin views, when tenantMiddleware has switched the request to it
// (`req.zaplie.actingAsPlatform`): GET only, never a write.
const { verifyMsalClaims, extractBearerToken } = require('./msalValidator');
const { ADMIN_ROLE, isZaplieAdmin } = require('./adminRoles');

const requireAdmin = async (req, res, next) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  let claims;
  try {
    claims = await verifyMsalClaims(token);
  } catch (error) {
    console.error('MSAL token validation failed:', error.message);
    res.status(401).json({ error: 'invalid token' });
    return;
  }
  if (req.zaplie?.actingAsPlatform) {
    if (req.method !== 'GET') {
      res.status(403).json({ error: 'platform support access is read-only' });
      return;
    }
    next();
    return;
  }
  if (!isZaplieAdmin(claims)) {
    res.status(403).json({ error: `${ADMIN_ROLE} role required` });
    return;
  }
  next();
};

module.exports = { requireAdmin, ADMIN_ROLE };
