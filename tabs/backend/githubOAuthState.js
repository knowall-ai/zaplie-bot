// filepath: tabs/backend/githubOAuthState.js
// Signed state ties the GitHub callback back to the oid that started the flow,
// so a forged callback can't link a GitHub account to someone else's person.
const crypto = require('crypto');

const STATE_TTL_MS = 5 * 60 * 1000; // time to complete the GitHub authorize round trip

const secret = () => {
  const value = process.env.IDENTITY_STATE_SECRET;
  if (!value) {
    throw new Error('IDENTITY_STATE_SECRET is not set');
  }
  return value;
};

const sign = (payload) =>
  crypto.createHmac('sha256', secret()).update(payload).digest('hex');

const signState = (oid) => {
  const expiry = Date.now() + STATE_TTL_MS;
  const payload = `${oid}|${expiry}`;
  return Buffer.from(`${payload}|${sign(payload)}`).toString('base64url');
};

const verifyState = (state) => {
  let decoded;
  try {
    decoded = Buffer.from(state, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('|');
  if (parts.length !== 3) {
    return null;
  }
  const [oid, expiryStr, signature] = parts;
  const expectedBuf = Buffer.from(sign(`${oid}|${expiryStr}`), 'hex');
  const signatureBuf = Buffer.from(signature, 'hex');
  if (
    expectedBuf.length !== signatureBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, signatureBuf)
  ) {
    return null;
  }
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) {
    return null;
  }
  return oid;
};

module.exports = { signState, verifyState };
