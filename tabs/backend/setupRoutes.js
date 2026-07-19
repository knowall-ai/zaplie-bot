// filepath: tabs/backend/setupRoutes.js
// GitHub App manifest flow (zero-config setup): an admin clicks once, GitHub
// creates the org's own Zaplie app and hands back the app id, private key,
// webhook secret and OAuth client credentials over the conversion API. No
// human ever copies a secret. Flow reference:
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
const express = require('express');
const crypto = require('crypto');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { requireAdmin } = require('./adminAuth');
const { signState, verifyState } = require('./githubOAuthState');
const { getCredentials, saveCredentials } = require('./githubAppCredentials');

const router = express.Router();

const PORTAL_URL = process.env.PORTAL_URL || 'https://localhost:3000';

// GET /api/setup/github/status — non-secret creation state for the portal.
router.get('/github/status', async (req, res) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    await verifyMsalToken(token);
  } catch (error) {
    console.error('MSAL token validation failed:', error.message);
    res.status(401).json({ error: 'invalid token' });
    return;
  }
  const credentials = getCredentials();
  res.json(
    credentials
      ? { created: true, slug: credentials.slug, htmlUrl: credentials.htmlUrl }
      : { created: false },
  );
});

// GET /api/setup/github/manifest — admin-only; returns the form-POST target
// and manifest JSON the browser submits to github.com/settings/apps/new.
router.get('/github/manifest', requireAdmin, async (req, res) => {
  const oid = 'admin'; // state binds the callback to a flow we started, not to a person
  const state = signState(oid);
  const suffix = crypto.randomBytes(2).toString('hex');
  const manifest = {
    name: `zaplie-rewards-${suffix}`,
    url: PORTAL_URL,
    redirect_url: `${PORTAL_URL}/api/setup/github/callback`,
    callback_urls: [`${PORTAL_URL}/api/identities/github/callback`],
    hook_attributes: {
      url: `${PORTAL_URL}/api/setup/github/webhook`,
      active: false,
    },
    public: false,
    request_oauth_on_install: true,
    default_permissions: {
      issues: 'read',
      pull_requests: 'read',
      metadata: 'read',
    },
    default_events: ['pull_request', 'issues'],
  };
  res.json({
    action: `https://github.com/settings/apps/new?state=${state}`,
    manifest: JSON.stringify(manifest),
  });
});

// GET /api/setup/github/callback — GitHub redirects the browser here with a
// one-shot code; the conversion response carries every credential we need.
router.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;
  if (typeof code !== 'string' || typeof state !== 'string' || !verifyState(state)) {
    res.redirect(`${PORTAL_URL}?setup=github_error`);
    return;
  }
  try {
    const response = await fetch(
      `https://api.github.com/app-manifests/${code}/conversions`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'zaplie-setup',
        },
      },
    );
    if (response.status !== 201) {
      throw new Error(`manifest conversion failed: ${response.status}`);
    }
    const app = await response.json();
    saveCredentials({
      appId: String(app.id),
      slug: app.slug,
      htmlUrl: app.html_url,
      clientId: app.client_id,
      clientSecret: app.client_secret,
      webhookSecret: app.webhook_secret,
      pem: app.pem,
      createdAt: new Date().toISOString(),
    });
    res.redirect(`${PORTAL_URL}?setup=github_created`);
  } catch (error) {
    console.error('GitHub App manifest conversion failed:', error.message);
    res.redirect(`${PORTAL_URL}?setup=github_error`);
  }
});

module.exports = router;
