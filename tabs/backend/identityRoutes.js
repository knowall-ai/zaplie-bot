// filepath: tabs/backend/identityRoutes.js
// "Connect GitHub" self-linking flow. Person canonical = LNbits user, anchored
// to aadObjectId; GitHub is an optional linked identity, matched by numeric id
// only (never the renamable login). See docs/wilmer/implementacion/identidad/.
const express = require('express');
const authMiddleware = require('./authMiddleware');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { signState, verifyState } = require('./githubOAuthState');
const identityStore = require('./identityStore');
const { requireLnbitsConfig, getLnbitsToken, lnbitsGet } = require('./lnbitsAdmin');
const { findUniqueUserByAadObjectId } = require('./lnbitsUserDirectory');

const router = express.Router();

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const PORTAL_URL = process.env.PORTAL_URL || '/';

const requireGithubOAuthConfig = () => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GITHUB_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET and GITHUB_OAUTH_REDIRECT_URI must be set',
    );
  }
  return { clientId, clientSecret, redirectUri };
};

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

// POST /api/identities/github/authorize-url
// Caller authenticates with a real MSAL ID token — never a client-supplied oid.
router.post('/github/authorize-url', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }

  let clientId, redirectUri;
  try {
    ({ clientId, redirectUri } = requireGithubOAuthConfig());
  } catch (error) {
    console.error(error.message);
    res.status(503).json({ error: 'GitHub OAuth is not configured' });
    return;
  }

  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user');
  url.searchParams.set('state', signState(oid));
  res.json({ authorizeUrl: url.toString() });
});

// GET /api/identities/github/callback — GitHub redirects here after authorizing.
router.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;
  if (typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).send('missing code or state');
    return;
  }
  const oid = verifyState(state);
  if (!oid) {
    res.status(400).send('invalid or expired state');
    return;
  }

  let clientId, clientSecret, redirectUri;
  try {
    ({ clientId, clientSecret, redirectUri } = requireGithubOAuthConfig());
  } catch (error) {
    console.error(error.message);
    res.status(503).send('GitHub OAuth is not configured');
    return;
  }

  try {
    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenResponse.ok) {
      throw new Error(`token exchange failed: ${tokenResponse.status}`);
    }
    const tokenBody = await tokenResponse.json();
    if (!tokenBody.access_token) {
      throw new Error(
        `token exchange response missing access_token: ${JSON.stringify(tokenBody)}`,
      );
    }

    const userResponse = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'zaplie-identity',
      },
    });
    if (!userResponse.ok) {
      throw new Error(`GitHub user fetch failed: ${userResponse.status}`);
    }
    const githubUser = await userResponse.json();

    // Match by the stable numeric id, never the renamable login.
    identityStore.linkIdentity({
      provider: 'github',
      providerId: String(githubUser.id),
      providerHandle: githubUser.login,
      personAad: oid,
    });

    res.redirect(`${PORTAL_URL}?github=connected`);
  } catch (error) {
    console.error('GitHub OAuth callback failed:', error);
    if (error.statusCode === 409) {
      res.redirect(`${PORTAL_URL}?github=conflict`);
      return;
    }
    res.redirect(`${PORTAL_URL}?github=error`);
  }
});

// GET /api/identities/mine — caller authenticates with a real MSAL ID token.
router.get('/mine', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  res.json({ identities: identityStore.findByPersonAad(oid) });
});

// GET /api/identities/resolve — internal, called by the bot (same weak
// placeholder-token pattern as /api/reward-amounts; known limitation, issue #171).
router.get('/resolve', authMiddleware, async (req, res) => {
  const { provider, providerId } = req.query;
  if (typeof provider !== 'string' || typeof providerId !== 'string') {
    res.status(400).json({ error: 'provider and providerId are required' });
    return;
  }
  const identity = identityStore.findByProviderId(provider, providerId);
  if (!identity) {
    res.status(404).json({ error: 'no identity linked' });
    return;
  }

  try {
    const config = requireLnbitsConfig();
    const accessToken = await getLnbitsToken(config);
    const usersBody = await lnbitsGet(`${config.nodeUrl}/users/api/v1/user`, accessToken);
    const user = findUniqueUserByAadObjectId(usersBody?.data, identity.personAad);
    if (!user || typeof user.id !== 'string' || user.id.length === 0) {
      res.status(502).json({
        error: `linked person ${identity.personAad} has no LNbits user`,
      });
      return;
    }
    res.json({ personAad: identity.personAad, lnbitsUserId: user.id });
  } catch (error) {
    console.error('LNbits identity resolution failed:', error.message);
    const status = error.message.includes('must be set') ? 503 : 502;
    res.status(status).json({ error: error.message });
  }
});

module.exports = router;
