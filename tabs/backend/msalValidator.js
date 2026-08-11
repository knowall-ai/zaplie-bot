const { createRemoteJWKSet, jwtVerify } = require('jose');

const requireEnvironment = (name) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured for the tabs backend`);
  }
  return value;
};

const tenantId = requireEnvironment('AAD_APP_TENANT_ID');
const clientId = requireEnvironment('AAD_APP_CLIENT_ID');
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const jwks = createRemoteJWKSet(
  new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
);

const verifyMsalAccessToken = async (token) => {
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: clientId,
    algorithms: ['RS256'],
  });

  const scopes = typeof payload.scp === 'string' ? payload.scp.split(' ') : [];
  if (!scopes.includes('access_as_user')) {
    throw new Error('access token is missing the access_as_user scope');
  }
  if (typeof payload.oid !== 'string' || payload.oid.length === 0) {
    throw new Error('access token is missing the oid claim');
  }

  return {
    oid: payload.oid,
    roles: Array.isArray(payload.roles) ? payload.roles : [],
  };
};

const extractBearerToken = (req) => {
  const header = req.headers.authorization || '';
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match ? match[1] : null;
};

module.exports = { verifyMsalAccessToken, extractBearerToken };
