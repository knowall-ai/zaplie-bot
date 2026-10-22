// filepath: tabs/backend/identityRoutes.js
// "Connect GitHub" self-linking flow. Person canonical = LNbits user, anchored
// to aadObjectId; GitHub is an optional linked identity, matched by numeric id
// only (never the renamable login). See docs/identity-connections.md.
const express = require('express');
const authMiddleware = require('./authMiddleware');
const { signPurposeState, verifyPurposeState } = require('./githubOAuthState');
const {
  issueBinding,
  bindingMatches,
  clearBinding,
} = require('./browserBinding');
const identityStore = require('./identityStore');
const { requireLnbitsConfig, getLnbitsToken, lnbitsGet } = require('./lnbitsAdmin');
const { requestTimeoutSignal } = require('./httpTimeout');
const { findUniqueUserByAadObjectId } = require('./lnbitsUserDirectory');
const {
  GithubAppNotConfiguredError,
  portalUrl,
  requireGithubOAuth,
} = require('./githubAppConfig');
const { requireMsalOid } = require('./requireMsalOid');

const router = express.Router();

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const BINDING_COOKIE = 'zaplie_gh_identity';
const BINDING_PATH = '/api/identities/github';

// POST /api/identities/github/authorize-url
// Caller authenticates with a real MSAL ID token — never a client-supplied oid.
router.post('/github/authorize-url', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }

  let clientId, redirectUri;
  try {
    ({ clientId, redirectUri } = requireGithubOAuth());
  } catch (error) {
    console.error(error.message);
    if (error instanceof GithubAppNotConfiguredError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(503).json({ error: 'GitHub OAuth is not configured' });
    return;
  }

  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  // No scope: a GitHub App's user token carries the App's permissions, and
  // GET /user needs none.
  // Bound to this browser too: otherwise someone could pass their link to a
  // colleague and have the colleague's GitHub account (and rewards) linked to
  // the sender (login CSRF). The flow runs in a top-level browser tab, where
  // the portal is first-party. See browserBinding.js.
  const binding = issueBinding(res, BINDING_COOKIE, BINDING_PATH);
  url.searchParams.set('state', signPurposeState('identity', [oid, binding]));
  res.json({ authorizeUrl: url.toString() });
});

// GET /api/identities/github/callback — GitHub redirects here after authorizing.
router.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;
  // One use only, whatever the outcome.
  clearBinding(res, BINDING_COOKIE, BINDING_PATH);
  if (typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).send('missing code or state');
    return;
  }
  const fields = verifyPurposeState('identity', state);
  if (!fields) {
    res.status(400).send('invalid or expired state');
    return;
  }
  const [oid, binding] = fields;
  if (!bindingMatches(req, BINDING_COOKIE, binding)) {
    console.error(
      'GitHub identity link returned to a browser that did not start it',
    );
    res.redirect(`${portalUrl()}?github=error`);
    return;
  }

  let clientId, clientSecret, redirectUri;
  try {
    ({ clientId, clientSecret, redirectUri } = requireGithubOAuth());
  } catch (error) {
    console.error(error.message);
    if (error instanceof GithubAppNotConfiguredError) {
      res.redirect(`${portalUrl()}?github=error`);
      return;
    }
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
      signal: requestTimeoutSignal(),
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
      signal: requestTimeoutSignal(),
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

    res.redirect(`${portalUrl()}?github=connected`);
  } catch (error) {
    console.error('GitHub OAuth callback failed:', error);
    if (error.statusCode === 409) {
      res.redirect(`${portalUrl()}?github=conflict`);
      return;
    }
    res.redirect(`${portalUrl()}?github=error`);
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
