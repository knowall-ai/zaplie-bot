// filepath: tabs/backend/msalValidator.js
// Verifies signature/issuer/audience via Entra's JWKS; a client-supplied
// aadObjectId would be forgeable, so oid is extracted only after this.
const { jwtVerify, createRemoteJWKSet } = require('jose');

let jwks = null;
const getJwks = () => {
  if (!jwks) {
    const tenantId = process.env.AAD_TENANT_ID;
    if (!tenantId) {
      throw new Error('AAD_TENANT_ID is not set');
    }
    jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    );
  }
  return jwks;
};

const verifyMsalToken = async (token) => {
  const tenantId = process.env.AAD_TENANT_ID;
  const clientId = process.env.AAD_CLIENT_ID;
  if (!tenantId || !clientId) {
    throw new Error('AAD_TENANT_ID and AAD_CLIENT_ID must be set');
  }
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    audience: clientId,
    algorithms: ['RS256'],
  });
  if (typeof payload.oid !== 'string' || payload.oid.length === 0) {
    throw new Error('token is missing the oid claim');
  }
  return payload.oid;
};

const extractBearerToken = (req) => {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1] : null;
};

module.exports = { verifyMsalToken, extractBearerToken };
