// filepath: tabs/backend/githubAppConfig.js
// One reader for the GitHub App's configuration. Env wins when present (same
// rule as secretsStore.getOrCreateSecret, so existing deployments keep their
// values), otherwise the credentials the manifest flow stored are used.
// Each group (App signing key, OAuth client, slug) resolves from one source as
// a whole: an env app id is never paired with a stored private key.
const fs = require('fs');
const { getCredentials } = require('./githubAppCredentials');

const DEFAULT_PORTAL_URL = 'https://localhost:3000';
const NOT_CONFIGURED_MESSAGE =
  'GitHub app not created yet: an admin can create it from Automations';

class GithubAppNotConfiguredError extends Error {
  constructor() {
    super(NOT_CONFIGURED_MESSAGE);
    this.name = 'GithubAppNotConfiguredError';
    this.status = 409;
  }
}

const portalUrl = () =>
  (process.env.PORTAL_URL || '').trim().replace(/\/+$/, '') ||
  DEFAULT_PORTAL_URL;

// PORTAL_URL may point at a route (the identity docs set it to Settings), so
// anything served by this backend is addressed from the origin.
const portalOrigin = () => new URL(portalUrl()).origin;

// Which source supplies each group. Presence checks only: no key file read and
// no URL parsing, so reporting the configuration cannot fail on either.
const appSource = (stored) => {
  if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
    return 'env';
  }
  return stored?.appId && stored?.pem ? 'manifest' : null;
};

const oauthSource = (stored) => {
  if (
    process.env.GITHUB_OAUTH_CLIENT_ID &&
    process.env.GITHUB_OAUTH_CLIENT_SECRET
  ) {
    return 'env';
  }
  return stored?.clientId && stored?.clientSecret ? 'manifest' : null;
};

const slugSource = (stored) => {
  if (process.env.GITHUB_APP_SLUG) return 'env';
  return stored?.slug ? 'manifest' : null;
};

const resolveApp = (stored) => {
  const source = appSource(stored);
  if (source === 'env') {
    const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    let privateKeyPem;
    try {
      privateKeyPem = fs.readFileSync(keyPath, 'utf8');
    } catch (error) {
      throw new Error(
        `failed to read GitHub App private key at ${keyPath}: ${error.message}`,
      );
    }
    return {
      value: { appId: process.env.GITHUB_APP_ID, privateKeyPem },
      source,
    };
  }
  if (source === 'manifest') {
    const value = { appId: String(stored.appId), privateKeyPem: stored.pem };
    // The account the manifest created the App under (the install check
    // compares installations against it). An env App looks it up instead.
    if (stored.ownerLogin) value.ownerLogin = stored.ownerLogin;
    return { value, source };
  }
  return { value: null, source };
};

// The manifest registers this exact callback for the stored client. Env OAuth
// credentials may override it with GITHUB_OAUTH_REDIRECT_URI. Only derived
// once a client exists, so a malformed PORTAL_URL breaks the OAuth flow that
// needs it and nothing else.
const manifestCallbackUri = () =>
  `${portalOrigin()}/api/identities/github/callback`;

const redirectUri = () =>
  process.env.GITHUB_OAUTH_REDIRECT_URI || manifestCallbackUri();

const resolveOAuth = (stored) => {
  const source = oauthSource(stored);
  if (source === 'env') {
    return {
      value: {
        clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
        clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
        redirectUri: redirectUri(),
      },
      source,
    };
  }
  if (source === 'manifest') {
    return {
      value: {
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
        // The stored client only has the manifest's callback registered, so
        // the env override (meant for a separate OAuth App) does not apply.
        redirectUri: manifestCallbackUri(),
      },
      source,
    };
  }
  return { value: null, source };
};

const resolveSlug = (stored) => {
  const source = slugSource(stored);
  if (source === 'env') return { value: process.env.GITHUB_APP_SLUG, source };
  if (source === 'manifest') return { value: stored.slug, source };
  return { value: null, source };
};

// source names where the App itself comes from: the signing key when one is
// configured, otherwise whichever group is.
const configSource = (stored) =>
  appSource(stored) || oauthSource(stored) || slugSource(stored);

const getGithubAppConfig = () => {
  const stored = getCredentials();
  return {
    app: resolveApp(stored).value,
    slug: resolveSlug(stored).value,
    oauth: resolveOAuth(stored).value,
    source: configSource(stored),
  };
};

// Non-secret state for the setup status route. Repositories can be connected
// only when both the install link (slug) and the App key that lists the
// installation's repositories resolve; source alone does not mean that.
// envKeyUnreadable is set only when a complete env App configuration has a
// key file that cannot be read. Env wins over the store, so creating an App
// cannot repair that: the portal hides its creation controls and points at
// the override instead.
const getGithubSetupState = () => {
  const stored = getCredentials();
  let installationReady = false;
  let envKeyUnreadable = false;
  if (slugSource(stored)) {
    try {
      installationReady = resolveApp(stored).value !== null;
    } catch (error) {
      // An unreadable env key file: configured, but not usable.
      console.error(error.message);
      envKeyUnreadable = true;
    }
  }
  return {
    source: configSource(stored) || 'none',
    installationReady,
    ...(envKeyUnreadable ? { envKeyUnreadable } : {}),
  };
};

// Each require resolves only its own group, so an unreadable key file breaks
// the routes that sign with it and not the install or identity links. A group
// fully set in env never reads the store, so a corrupt store cannot block it;
// one that does need the store still gets the store's (generic) error.
const requireGroup = (sourceOf, resolve) => {
  const stored = sourceOf(null) === 'env' ? null : getCredentials();
  const { value } = resolve(stored);
  if (!value) throw new GithubAppNotConfiguredError();
  return value;
};

const requireGithubApp = () => requireGroup(appSource, resolveApp);
const requireGithubOAuth = () => requireGroup(oauthSource, resolveOAuth);
const requireGithubSlug = () => requireGroup(slugSource, resolveSlug);

module.exports = {
  GithubAppNotConfiguredError,
  NOT_CONFIGURED_MESSAGE,
  portalUrl,
  portalOrigin,
  getGithubAppConfig,
  getGithubSetupState,
  requireGithubApp,
  requireGithubOAuth,
  requireGithubSlug,
};
