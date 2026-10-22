// filepath: tabs/backend/browserBinding.js
// Binds a GitHub round trip to the browser that started it. The signed state
// already ties a flow to the person's oid, but anyone holding that state could
// hand the GitHub link to someone else, whose authorization would then land
// under the first person's account (login CSRF). So starting a flow also sets
// a random nonce in a short-lived HttpOnly cookie and puts only its hash in
// the state; each callback requires the cookie to match. SameSite=Lax is
// enough: GitHub returns the browser with top-level GET redirects, which Lax
// cookies accompany.
const crypto = require('crypto');

const BINDING_MAX_AGE_MS = 10 * 60 * 1000; // two GitHub round trips at most

const cookieOptions = (path) => ({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path,
});

const hashNonce = (nonce) =>
  crypto.createHash('sha256').update(nonce).digest('hex');

// Sets the cookie and returns the hash to sign into the state.
const issueBinding = (res, name, path) => {
  const nonce = crypto.randomBytes(32).toString('base64url');
  res.cookie(name, nonce, { ...cookieOptions(path), maxAge: BINDING_MAX_AGE_MS });
  return hashNonce(nonce);
};

const readCookie = (req, name) => {
  for (const pair of (req.headers.cookie || '').split(';')) {
    const index = pair.indexOf('=');
    if (index > 0 && pair.slice(0, index).trim() === name) {
      return pair.slice(index + 1).trim();
    }
  }
  return null;
};

const bindingMatches = (req, name, expectedHash) => {
  const nonce = readCookie(req, name);
  if (!nonce || typeof expectedHash !== 'string') {
    return false;
  }
  const actual = Buffer.from(hashNonce(nonce), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

const clearBinding = (res, name, path) => {
  res.clearCookie(name, cookieOptions(path));
};

module.exports = { issueBinding, bindingMatches, clearBinding };
