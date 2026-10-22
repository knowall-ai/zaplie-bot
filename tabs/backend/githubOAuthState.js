// filepath: tabs/backend/githubOAuthState.js
// Signed state ties the GitHub callback back to the oid that started the flow,
// so a forged callback can't link a GitHub account to someone else's person.
const crypto = require('crypto');
const { getOrCreateSecret } = require('./secretsStore');

const STATE_TTL_MS = 5 * 60 * 1000; // time to complete the GitHub authorize round trip

const secret = () => getOrCreateSecret('IDENTITY_STATE_SECRET');

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

// Purpose-tagged state for the GitHub round trips that must not be mixed up:
// 'identity' (oid, browser binding hash) for "Connect GitHub" and 'install'
// (oid, browser binding hash) for "Connect repositories". The tag and the
// field count must both match, so neither passes as the other, and neither
// passes verifyState (which takes exactly three parts) or the reverse: the
// manifest callback still accepts only the plain 'admin' state.
const PURPOSE_FIELDS = { identity: 2, install: 2 };

const signPurposeState = (purpose, fields) => {
  if (
    fields.length !== PURPOSE_FIELDS[purpose] ||
    fields.some((field) => typeof field !== 'string' || field.includes('|'))
  ) {
    throw new Error(`invalid ${purpose} state fields`);
  }
  const expiry = Date.now() + STATE_TTL_MS;
  const payload = [purpose, ...fields, expiry].join('|');
  return Buffer.from(`${payload}|${sign(payload)}`).toString('base64url');
};

// Returns the fields, or null for anything forged, expired or of another flow.
const verifyPurposeState = (purpose, state) => {
  if (typeof state !== 'string' || !PURPOSE_FIELDS[purpose]) {
    return null;
  }
  const parts = Buffer.from(state, 'base64url').toString('utf8').split('|');
  if (parts.length !== PURPOSE_FIELDS[purpose] + 3 || parts[0] !== purpose) {
    return null;
  }
  const signature = parts.pop();
  const expectedBuf = Buffer.from(sign(parts.join('|')), 'hex');
  const signatureBuf = Buffer.from(signature, 'hex');
  if (
    expectedBuf.length !== signatureBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, signatureBuf)
  ) {
    return null;
  }
  const expiry = Number(parts.pop());
  if (!Number.isFinite(expiry) || Date.now() > expiry) {
    return null;
  }
  return parts.slice(1);
};

module.exports = {
  signState,
  verifyState,
  signPurposeState,
  verifyPurposeState,
};
