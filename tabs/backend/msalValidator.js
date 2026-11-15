// filepath: tabs/backend/msalValidator.js
// Verifies an Entra ID token: signature, issuer and audience, against the
// signing keys of the token's own tenant. A client-supplied aadObjectId would
// be forgeable, so oid (and tid) are only ever read after this.
//
// Tenants: only tenants on the allow-list (ZAPLIE_ALLOWED_TENANTS, default
// the home tenant AAD_TENANT_ID, tenantConfig.js) are accepted. The token's
// `tid` is read first (unverified) only to choose which tenant's keys and
// issuer to verify against; a tenant not listed is refused before any
// verification, so a token correctly signed by another tenant gets nowhere.
const { createRemoteJWKSet, decodeJwt, jwtVerify } = require('jose');
const { homeTenant, isAllowedTenant, normalizeTid } = require('./tenantConfig');

const jwksByTenant = new Map();
const remoteKeysFor = (tid) => {
  if (!jwksByTenant.has(tid)) {
    jwksByTenant.set(
      tid,
      createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`)),
    );
  }
  return jwksByTenant.get(tid);
};

let keysFor = remoteKeysFor;

/** Tests verify against local keys instead of Entra's discovery endpoint. */
const setKeyResolverForTests = (resolver) => {
  keysFor = resolver || remoteKeysFor;
};

const verifyMsalPayload = async (token) => {
  const clientId = process.env.AAD_CLIENT_ID;
  if (!homeTenant() || !clientId) {
    throw new Error('AAD_TENANT_ID and AAD_CLIENT_ID must be set');
  }
  let unverified;
  try {
    unverified = decodeJwt(token);
  } catch (_error) {
    throw new Error('token is malformed');
  }
  const tid = normalizeTid(unverified.tid);
  if (!tid || !isAllowedTenant(tid)) {
    throw new Error('token is from a tenant Zaplie does not serve');
  }
  const { payload } = await jwtVerify(token, keysFor(tid), {
    issuer: `https://login.microsoftonline.com/${tid}/v2.0`,
    audience: clientId,
    algorithms: ['RS256'],
  });
  if (normalizeTid(payload.tid) !== tid) {
    throw new Error('token tenant does not match its issuer');
  }
  if (typeof payload.oid !== 'string' || payload.oid.length === 0) {
    throw new Error('token is missing the oid claim');
  }
  return payload;
};

const verifyMsalToken = async (token) => (await verifyMsalPayload(token)).oid;

// App roles (Entra "roles") and directory roles (Entra "wids", emitted when
// the registration's groupMembershipClaims includes DirectoryRole) arrive in
// the same verified token.
const verifyMsalClaims = async (token) => {
  const payload = await verifyMsalPayload(token);
  return {
    oid: payload.oid,
    tid: normalizeTid(payload.tid),
    roles: Array.isArray(payload.roles) ? payload.roles : [],
    wids: Array.isArray(payload.wids) ? payload.wids : [],
  };
};

const extractBearerToken = (req) => {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1] : null;
};

module.exports = {
  extractBearerToken,
  setKeyResolverForTests,
  verifyMsalClaims,
  verifyMsalPayload,
  verifyMsalToken,
};
