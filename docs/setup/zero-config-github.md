# Zero-config GitHub setup (App manifest flow)

Zaplie creates your organisation's GitHub App for you. An admin clicks once,
GitHub shows a single confirmation screen, and every credential (App ID,
private key, webhook secret, OAuth client id and secret) travels from GitHub to
the Zaplie server over the conversion API. Nobody types or copies a secret,
ever.

Reference: [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

## How it works

1. **Create** - portal, Automations page, GitHub card: an admin (the
   `Zaplie.Admin` app role) enters the GitHub organisation that owns the
   repositories to reward and clicks "Create the Zaplie GitHub App". The
   browser form-POSTs a manifest (name, permissions, redirect URL) to
   `github.com/organizations/<org>/settings/apps/new` with an HMAC-signed
   `state`. The App is private, and GitHub installs a private App only on the
   account that owns it, so create it under the organisation that owns the
   repositories. That needs an organisation owner, or a member GitHub has
   made an App manager. With the organisation left empty, the App is
   registered under the admin's personal account
   (`github.com/settings/apps/new`) and can only be installed there. The
   backend accepts only a valid GitHub login (letters, digits and single
   inner hyphens, at most 39 characters) and answers 400 otherwise.
2. **Confirm** - GitHub shows one pre-filled "Create GitHub App" screen. The
   admin confirms and GitHub redirects to
   `/api/setup/github/callback?code=...&state=...`.
3. **Convert** - the tab backend calls
   `POST https://api.github.com/app-manifests/{code}/conversions` and receives
   the App ID, slug, owner, private key, webhook secret and OAuth client
   credentials in one response. They are persisted server-side in
   `github-app-credentials.json` under `ZAPLIE_DATA_DIR` (owner-only, written
   atomically, gitignored) and never logged or sent to the browser. The admin
   lands back on `/automations?setup=github_created` (or
   `?setup=github_error`), which the page shows as a toast.
4. **Install** - the "Connect repositories" button (admins only: the
   install link is issued only to the `Zaplie.Admin` role) sends the admin to
   `github.com/apps/{slug}/installations/new?state=...` to pick repositories,
   exactly like Vercel or Linear. The button stays disabled until the App
   exists. Issuing the link also sets a short-lived `HttpOnly`, `Secure`,
   `SameSite=Lax` cookie scoped to `/api/connections/github`, and the state
   carries only its hash, which binds the install to the admin's browser.
   GitHub then redirects to the App's setup URL,
   `/api/connections/github/setup?installation_id=...&setup_action=install&state=...`.
5. **Check and record** - GitHub documents that a setup URL's
   `installation_id` can be spoofed, so the setup route checks it before
   saving anything. It needs the signed `install` state from the install link
   (which names the person) and the binding cookie from step 4, which it
   clears. A missing or different cookie (an install link handed to someone
   else) is refused before GitHub is asked anything. The id must be canonical:
   a positive integer with no leading zeros and at most 15 digits. It then calls
   `GET /app/installations/{installation_id}` with the App JWT. A 404 means
   the id is not an installation of this App. Otherwise the installation's
   `account.login` must equal the App owner's login, compared
   case-insensitively. The owner comes from the manifest conversion, or for
   an env-configured App from `GET /app`, cached in memory. Because the App
   is private, its only possible installation is on its owner, so this match
   is sufficient. No user sign-in or user token is involved. On a match the
   installation is saved and the portal shows `?github=repos_connected`. A
   404, another account, a GitHub error, a bad state or a browser that did
   not start the install shows `?github=install_error`, and the log says
   which.

With `setup_on_update`, GitHub also redirects to the setup URL after a
repository change made on its own settings page. That redirect carries no
state of ours, so it records nothing and shows `?github=repos_updated`. An
install that an organisation owner still has to approve
(`setup_action=request`) shows `?github=install_requested`.

GitHub won't load inside a frame, and the portal runs in a frame inside the
Teams tab. Run the setup and "Connect repositories" from the portal open in a
browser tab. There the portal is first-party, so the binding cookie returns on
GitHub's top-level redirect to the setup URL.

The conversion code is one-shot and the whole flow must finish within one
hour; a stale or replayed code fails loudly and the admin just clicks the
button again.

## Apps created from the earlier manifest

The earlier manifest set no setup URL and turned on "Request user
authorization (OAuth) during installation", so an App created from it never
returns to the setup URL and cannot connect repositories. In that App's
settings on GitHub (Settings > Developer settings > GitHub Apps > the Zaplie
App):

1. Set "Setup URL" to `<origin>/api/connections/github/setup`.
2. Enable "Redirect on update".
3. Disable "Request user authorization (OAuth) during installation".

Its stored credentials have no owner login, so the install check looks the
owner up with `GET /app`. Alternatively, delete the App on GitHub, remove
`github-app-credentials.json` from `ZAPLIE_DATA_DIR`, and create it again from
Automations. If no App was created before this change (true for production
today), nothing needs doing.

## Design notes

- No `GITHUB_*` environment variables are needed. Every GitHub-backed route
  (App JWT, install URL, identity OAuth) reads its configuration through
  `tabs/backend/githubAppConfig.js`.
- Precedence: env first, then the stored manifest credentials, the same rule
  as the internal secrets below. Each group resolves from one source as a
  whole and never mixes the two: the App key (`GITHUB_APP_ID` +
  `GITHUB_APP_PRIVATE_KEY_PATH`), the OAuth client
  (`GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET`) and the slug
  (`GITHUB_APP_SLUG`). A partly set group is ignored in favour of the stored
  one.
- Callback URLs are built from the origin of `PORTAL_URL`, because that
  variable may point at a route such as Settings. The manifest registers
  `<origin>/api/setup/github/callback`, the callback URL
  `<origin>/api/identities/github/callback` and the setup URL
  `<origin>/api/connections/github/setup`. With the stored client, the
  identity flow always sends that callback as its `redirect_uri`.
  `GITHUB_OAUTH_REDIRECT_URI` applies only to env OAuth credentials whose App
  registers the identity callback at a different URL.
- Env OAuth credentials (`GITHUB_OAUTH_CLIENT_ID` and
  `GITHUB_OAUTH_CLIENT_SECRET`, both or neither) must be the Zaplie GitHub
  App's own client ID and secret, not those of a separate OAuth App.
- The browser round trips use purpose-tagged signed states (`identity` for
  "Connect GitHub", `install` for "Connect repositories"). Neither passes as
  the other, and neither passes as the plain `admin` state the manifest
  callback accepts. Each also carries the hash of a browser binding cookie
  (`zaplie_gh_identity` or `zaplie_gh_install`, 10 minutes, scoped to its
  routes), so a link forwarded to someone else records nothing for the sender
  (login CSRF).
- A group set entirely in env never reads the credentials file, so a corrupt
  file cannot block it.
- Until the app is created, GitHub-backed endpoints respond
  `409 GitHub app not created yet: an admin can create it from Automations` -
  a clear pointer to the setup button, never a crash or a silent failure.
- `GET /api/setup/github/status` (any signed-in user, non-secret fields only)
  returns `created`, `slug`, `htmlUrl`, `source` and `installationReady`.
  `created` is true only once the manifest flow has stored an App; an App
  configured purely by env vars reports `created: false` with `source: env`.
  `source` is `env` when the App comes from env vars, `manifest` when it comes
  from the stored credentials, `none` before either exists.
  `installationReady` is true only when both the slug and the App key resolve,
  since checking and listing an installation needs the key: a
  `GITHUB_APP_SLUG` on its own reports `env` but not ready. Automations
  enables "Connect repositories" only when ready, and shows "configured by
  environment" (no creation click) for a complete env configuration.
  `envKeyUnreadable: true` is added when a complete env App configuration
  has a key file that cannot be read; since env wins over the store, creating
  an App cannot fix that, so Automations hides the creation controls and
  points at the override instead.
- A corrupt credentials file or a `PORTAL_URL` that does not parse fails the
  affected route with a generic error. Neither the file's contents nor the
  parser's message reaches a response.
- The same app authorizes users for identity linking ("Connect GitHub" in
  Settings), so one creation click covers both the org connection and personal
  identity. The manifest sets `request_oauth_on_install: false`: with it on,
  GitHub skips the setup URL after an install and runs its own OAuth flow into
  the identity callback with no `state` and no installation id, so the
  installation was never recorded. Installing the App and linking an identity
  are therefore two separate steps.
- Internal secrets that only Zaplie itself consumes (`IDENTITY_STATE_SECRET`,
  the Nostr org key) are generated with `crypto.randomBytes` on first use and
  persisted server-side (`tabs/backend/secrets.json`, gitignored). They are
  not configuration.
