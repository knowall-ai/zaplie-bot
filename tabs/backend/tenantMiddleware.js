// filepath: tabs/backend/tenantMiddleware.js
// Decides which organisation a request acts for, then runs the rest of the
// request in that tenant's context (tenantContext.js):
//
//   * a verified Entra token: its own `tid` (msalValidator.js has already
//     refused any tenant not on the allow-list);
//   * KnowAll's platform operator (adminRoles.js) may read another allowed
//     organisation by sending X-Zaplie-Act-As-Tenant on a GET;
//   * the bot's shared-token calls: X-Zaplie-Tenant, which must name an
//     allowed tenant (absent: the home tenant). Only the bot's own token
//     makes the header count: anyone else stays in the home tenant;
//   * anything else (public reads, invalid tokens the route will refuse):
//     the home tenant.
const { createHash, timingSafeEqual } = require('crypto');
const { extractBearerToken, verifyMsalPayload: defaultVerify } = require('./msalValidator');
const { isPlatformOperator } = require('./adminRoles');
const { homeTenant, isAllowedTenant, normalizeTid } = require('./tenantConfig');
const { runWithTenant } = require('./tenantContext');

const digest = (value) => createHash('sha256').update(String(value)).digest();

// The same comparison authMiddleware.js makes, so the tenant header is never
// honoured for a caller the route is about to refuse.
const isBotToken = (header, env = process.env) => {
  const expected = env.TAB_BACKEND_TOKEN;
  return Boolean(expected) && typeof header === 'string' && timingSafeEqual(digest(header), digest(expected));
};

/**
 * For what the whole deployment shares and only the home organisation may
 * use yet (docs/MULTI_TENANT.adoc): the Fund wallet and allowance sync, the
 * GitHub App and its identity and repository links. Any other organisation,
 * and the platform operator acting for one, gets a 403.
 */
const requireHomeTenant = (req, res, next) => {
  const home = homeTenant();
  if (req.zaplie && home && req.zaplie.tid !== home) {
    res.status(403).json({ error: 'not available for this organisation yet' });
    return;
  }
  next();
};

const createTenantMiddleware = ({ verifyMsalPayload = defaultVerify } = {}) => async (req, res, next) => {
  req.zaplie = { tid: homeTenant(), actingAsPlatform: false };
  const bearer = extractBearerToken(req);
  if (bearer) {
    try {
      const claims = await verifyMsalPayload(bearer);
      req.zaplie.tid = normalizeTid(claims.tid);
      const actAs = normalizeTid(req.get('X-Zaplie-Act-As-Tenant'));
      if (actAs && actAs !== req.zaplie.tid) {
        if (!isPlatformOperator(claims) || req.method !== 'GET' || !isAllowedTenant(actAs)) {
          res.status(403).json({ error: 'not allowed to act for another organisation' });
          return;
        }
        req.zaplie = { tid: actAs, actingAsPlatform: true };
      }
    } catch (_error) {
      // The route verifies again and answers 401; until then, the home tenant.
    }
  } else if (isBotToken(req.headers.authorization)) {
    const named = req.get('X-Zaplie-Tenant');
    if (named !== undefined) {
      if (!isAllowedTenant(named)) {
        res.status(403).json({ error: 'unknown organisation' });
        return;
      }
      req.zaplie.tid = normalizeTid(named);
    }
  }
  runWithTenant(req.zaplie.tid, next);
};

module.exports = { createTenantMiddleware, requireHomeTenant, tenantMiddleware: createTenantMiddleware() };
