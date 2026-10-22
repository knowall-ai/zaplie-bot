// filepath: tabs/backend/connectionsRoutes.js
// GitHub App "install -> select repositories" flow. The person installs the
// app choosing repos; GitHub redirects back to /github/setup with the
// installation id and our signed state, which ties it to the caller's oid.
// The setup URL also requires the browser binding cookie set when the install
// link was issued (browserBinding.js), so a link handed to someone else cannot
// attach their installation to the sender's account. GitHub documents that the
// setup URL's installation_id can be spoofed, so the id is then checked with
// the App JWT before it is saved (see /github/setup).
const express = require('express');
const { signPurposeState, verifyPurposeState } = require('./githubOAuthState');
const {
  issueBinding,
  bindingMatches,
  clearBinding,
} = require('./browserBinding');
const connectionsStore = require('./connectionsStore');
const {
  listInstallationRepos,
  findAppInstallation,
  getAppOwnerLogin,
} = require('./githubAppAuth');
const {
  GithubAppNotConfiguredError,
  portalUrl,
  requireGithubSlug,
} = require('./githubAppConfig');
const { requireMsalOid } = require('./requireMsalOid');
const { requireAdmin } = require('./adminAuth');

const router = express.Router();

const BINDING_COOKIE = 'zaplie_gh_install';
const BINDING_PATH = '/api/connections/github';

// POST /api/connections/github/install-url — admin-only (Zaplie.Admin). The
// installation belongs to the organisation and exposes its private repository
// list, so only an admin may attach it. The signed state ties the install
// redirect back to the admin's oid, and /github/setup accepts nothing else, so
// this gate also covers the setup URL (a top-level GitHub redirect that carries
// no bearer token).
router.post('/github/install-url', requireAdmin, async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  let slug;
  try {
    slug = requireGithubSlug();
  } catch (error) {
    console.error(error.message);
    if (error instanceof GithubAppNotConfiguredError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'GitHub App configuration is unavailable' });
    return;
  }
  // Bound to this browser too: the install link only works in the browser that
  // asked for it. The flow runs in a top-level browser tab (GitHub refuses to
  // load in a frame), where the portal is first-party, so the SameSite=Lax
  // cookie returns on GitHub's redirect to the setup URL.
  const binding = issueBinding(res, BINDING_COOKIE, BINDING_PATH);
  const state = signPurposeState('install', [oid, binding]);
  const installUrl = `https://github.com/apps/${slug}/installations/new?state=${state}`;
  res.json({ installUrl });
});

// GET /api/connections/github/setup — the App's setup URL (set by the
// manifest). GitHub redirects the browser here after an install or, with
// setup_on_update, after the repository selection changes, passing
// installation_id, setup_action and the state from our install link.
router.get('/github/setup', async (req, res) => {
  const {
    installation_id: installationId,
    setup_action: setupAction,
    state,
  } = req.query;
  const fail = () => res.redirect(`${portalUrl()}?github=install_error`);
  // An org member without rights asked an owner to install: nothing exists yet.
  if (setupAction === 'request') {
    res.redirect(`${portalUrl()}?github=install_requested`);
    return;
  }
  const started = verifyPurposeState('install', state);
  if (!started) {
    // A change made on GitHub's own settings page carries no state of ours.
    // The installation was recorded when it was created and its repositories
    // are listed live, so there is nothing to write.
    if (setupAction === 'update') {
      res.redirect(`${portalUrl()}?github=repos_updated`);
      return;
    }
    fail();
    return;
  }
  // From here on this is our install round trip: the binding is one use only,
  // whatever the outcome, and must match before GitHub is asked anything.
  clearBinding(res, BINDING_COOKIE, BINDING_PATH);
  const [oid, binding] = started;
  if (!bindingMatches(req, BINDING_COOKIE, binding)) {
    console.error('GitHub install returned to a browser that did not start it');
    fail();
    return;
  }
  // Canonical positive id only: no leading zeros, at most 15 digits.
  if (
    typeof installationId !== 'string' ||
    !/^[1-9]\d{0,14}$/.test(installationId)
  ) {
    fail();
    return;
  }
  // The manifest makes the App private, and GitHub installs a private App only
  // on the account that owns it. So a genuine installation of this App belongs
  // to that account: ask GitHub (App JWT, no user sign-in) and save the id only
  // if it is ours and on the owner's account.
  try {
    const installation = await findAppInstallation(installationId);
    if (!installation) {
      console.error(
        `GitHub installation ${installationId} is not an installation of this App (404)`,
      );
      fail();
      return;
    }
    const ownerLogin = await getAppOwnerLogin();
    if (installation.accountLogin.toLowerCase() !== ownerLogin.toLowerCase()) {
      console.error(
        `GitHub installation ${installationId} is on ${installation.accountLogin}, not the App owner ${ownerLogin}`,
      );
      fail();
      return;
    }
  } catch (error) {
    console.error('GitHub installation check failed:', error.message);
    fail();
    return;
  }
  connectionsStore.setInstallation(oid, installationId);
  res.redirect(`${portalUrl()}?github=repos_connected`);
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
    const status = error instanceof GithubAppNotConfiguredError ? 409 : 502;
    res.status(status).json({ error: error.message });
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
