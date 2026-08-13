// filepath: tabs/backend/connectionsRoutes.js
// GitHub App "install -> select repositories" flow. The person installs the
// app choosing repos; GitHub redirects back to /github/setup with the
// installation id, which we tie to the caller's oid via the signed state.
const express = require('express');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { signState, verifyState } = require('./githubOAuthState');
const connectionsStore = require('./connectionsStore');
const { listInstallationRepos } = require('./githubAppAuth');

const router = express.Router();

const PORTAL_URL = process.env.PORTAL_URL || 'https://localhost:3000';

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

// POST /api/connections/github/install-url — caller authenticates with a real
// MSAL ID token; the signed state ties the install redirect back to their oid.
router.post('/github/install-url', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) {
    console.error('GITHUB_APP_SLUG is not set');
    res.status(503).json({ error: 'GitHub App is not configured' });
    return;
  }
  const installUrl = `https://github.com/apps/${slug}/installations/new?state=${signState(
    oid,
  )}`;
  res.json({ installUrl });
});

// GET /api/connections/github/setup — GitHub redirects the browser here after
// the user installs the app and picks repositories.
router.get('/github/setup', (req, res) => {
  const { installation_id: installationId, state } = req.query;
  const oid = typeof state === 'string' ? verifyState(state) : null;
  if (!oid) {
    res.redirect(`${PORTAL_URL}?github=install_error`);
    return;
  }
  if (installationId) {
    connectionsStore.setInstallation(oid, String(installationId));
    res.redirect(`${PORTAL_URL}?github=repos_connected`);
    return;
  }
  res.redirect(`${PORTAL_URL}?github=install_error`);
});

// GET /api/connections/github/repos — caller authenticates with a real MSAL ID
// token; "not connected" is a normal state, never an error.
router.get('/github/repos', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  const installationId = connectionsStore.getInstallation(oid);
  if (!installationId) {
    res.json({ connected: false, repositories: [] });
    return;
  }
  try {
    const repositories = await listInstallationRepos(installationId);
    res.json({ connected: true, repositories });
  } catch (error) {
    console.error('Listing installation repositories failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

// GET /api/connections/github — caller authenticates with a real MSAL ID token.
router.get('/github', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  res.json({ connected: !!connectionsStore.getInstallation(oid) });
});

module.exports = router;
