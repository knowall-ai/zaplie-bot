# Zero-config GitHub setup (App manifest flow)

Zaplie creates your organisation's GitHub App for you. An admin clicks once,
GitHub shows a single confirmation screen, and every credential (App ID,
private key, webhook secret, OAuth client id and secret) travels from GitHub to
the Zaplie server over the conversion API. Nobody types or copies a secret,
ever.

Reference: [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

## How it works

1. **Create** - portal, Automations page, GitHub card: an admin clicks
   "Create the Zaplie GitHub App". The browser form-POSTs a manifest (name,
   permissions, redirect URL) to `github.com/settings/apps/new` with an
   HMAC-signed `state`.
2. **Confirm** - GitHub shows one pre-filled "Create GitHub App" screen. The
   admin confirms and GitHub redirects to
   `/api/setup/github/callback?code=...&state=...`.
3. **Convert** - the tab backend calls
   `POST https://api.github.com/app-manifests/{code}/conversions` and receives
   the App ID, slug, private key, webhook secret and OAuth client credentials
   in one response. They are persisted server-side
   (`tabs/backend/github-app-credentials.json`, gitignored; Key Vault in a
   cloud deployment) and never logged or sent to the browser.
4. **Install** - the "Connect repositories" button sends the admin to
   `github.com/apps/{slug}/installations/new` to pick repositories, exactly
   like Vercel or Linear.

The conversion code is one-shot and the whole flow must finish within one
hour; a stale or replayed code fails loudly and the admin just clicks the
button again.

## Design notes

- Credentials are provisioned exclusively by the manifest flow and live
  server-side. Until the app is created, GitHub-backed endpoints respond
  `409 GitHub app not created yet: an admin can create it from Automations` -
  a clear pointer to the setup button, never a crash or a silent failure.
- The same app authorizes users for identity linking ("Connect GitHub" in
  Settings), so one creation click covers both the org connection and personal
  identity.
- Internal secrets that only Zaplie itself consumes (`IDENTITY_STATE_SECRET`,
  the Nostr org key) are generated with `crypto.randomBytes` on first use and
  persisted server-side (`tabs/backend/secrets.json`, gitignored). They are
  not configuration.
