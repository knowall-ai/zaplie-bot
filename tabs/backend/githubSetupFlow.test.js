// The whole zero-config path with no GITHUB_* env vars: an admin creates the
// App through the manifest flow and installs it on repositories through the
// App's setup URL; the installation is saved only after the App JWT shows it
// is an installation of this App on the account that owns it; the portal
// lists its repositories with the stored key; and a teammate links their
// GitHub identity with the stored OAuth client, which is what the reward flow
// resolves recipients by. Both round trips are bound to the browser that
// started them by a cookie, so a forwarded link records nothing.
// GitHub and LNbits are stubbed at fetch; everything else is the real server.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-github-flow-'));
process.env.ZAPLIE_DATA_DIR = tempDir;
process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
process.env.AAD_TENANT_ID = 'test-tenant';
process.env.AAD_CLIENT_ID = 'test-client';
process.env.PORTAL_URL = 'https://portal.example.com/settings';
process.env.LNBITS_NODE_URL = 'https://lnbits.test';
process.env.LNBITS_USERNAME = 'zaplie';
process.env.LNBITS_PASSWORD = 'lnbits-password';
const GITHUB_ENV = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_APP_SLUG',
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITHUB_OAUTH_REDIRECT_URI',
];
for (const key of GITHUB_ENV) {
  delete process.env[key];
}

const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const http = require('http');

const ADMIN_TOKEN = 'admin-token';
const USER_TOKEN = 'user-token';

// Same require.cache stand-in as configRoutes.test.js.
const claimsFor = token => {
  if (token !== ADMIN_TOKEN && token !== USER_TOKEN) {
    throw new Error('invalid token');
  }
  return {
    oid: token === ADMIN_TOKEN ? 'oid-admin' : 'oid-user',
    roles: token === ADMIN_TOKEN ? ['Zaplie.Admin'] : [],
  };
};

const validatorPath = require.resolve('./msalValidator');
require.cache[validatorPath] = {
  id: validatorPath,
  filename: validatorPath,
  loaded: true,
  exports: {
    verifyMsalPayload: async token => claimsFor(token),
    verifyMsalToken: async token => claimsFor(token).oid,
    verifyMsalClaims: async token => claimsFor(token),
    extractBearerToken: req => {
      const header = req.headers['authorization'] || '';
      return header.startsWith('Bearer ') ? header.slice(7) : null;
    },
  },
};

const app = require('./server');

// GitHub issues PKCS1 keys from the manifest conversion.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ORIGIN = 'https://portal.example.com';
const SETTINGS = `${ORIGIN}/settings`;
const CODE = 'one-shot-code';
const IDENTITY_URI = `${ORIGIN}/api/identities/github/callback`;
// The organisation the App is registered under; GitHub keeps the case.
const OWNER = 'Acme-Org';
// Installation ids the stub knows, by what GitHub would answer for them.
const OURS = '4242'; // this App, on the owner's account (login in lower case)
const ELSEWHERE = '5150'; // this App, on another account
const NOT_OURS = '999'; // 404: not an installation of this App
const FAILING = '503'; // GitHub answers 502
// The one user token the stub hands out (identity linking). It must never be
// stored or logged.
const USER_TOKEN_VALUE = 'ghu_identity_token';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const verifyAppJwt = authorization => {
  const [header, payload, signature] = (authorization || '')
    .replace(/^Bearer /, '')
    .split('.');
  if (!signature) return false;
  const valid = crypto
    .createVerify('RSA-SHA256')
    .update(`${header}.${payload}`)
    .verify(publicKey, signature, 'base64url');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return valid && claims.iss === '777';
};

const calls = [];

const stub = async (input, options = {}) => {
  const url = String(input);
  const auth = options.headers?.Authorization;
  calls.push(url);
  if (url === `https://api.github.com/app-manifests/${CODE}/conversions`) {
    return json(201, {
      id: 777,
      slug: 'zaplie-rewards-beef',
      html_url: 'https://github.com/apps/zaplie-rewards-beef',
      owner: { login: OWNER, type: 'Organization' },
      client_id: 'Iv1.manifest',
      client_secret: 'manifest-secret',
      webhook_secret: 'manifest-webhook',
      pem: privateKey,
    });
  }
  const installation =
    /^https:\/\/api\.github\.com\/app\/installations\/(\d+)$/.exec(url);
  if (installation) {
    if (!verifyAppJwt(auth)) return json(401, { message: 'Bad credentials' });
    const id = installation[1];
    if (id === OURS)
      return json(200, { id: 4242, account: { login: 'acme-org' } });
    if (id === ELSEWHERE) {
      return json(200, { id: 5150, account: { login: 'someone-else' } });
    }
    if (id === FAILING) return json(502, { message: 'Server Error' });
    return json(404, { message: 'Not Found' });
  }
  if (url === 'https://api.github.com/app') {
    if (!verifyAppJwt(auth)) return json(401, { message: 'Bad credentials' });
    return json(200, { id: 777, owner: { login: OWNER } });
  }
  if (url === 'https://github.com/login/oauth/access_token') {
    const body = JSON.parse(options.body);
    // Only the stored manifest client is ever presented, and only for the
    // identity link.
    assert.equal(body.client_id, 'Iv1.manifest');
    assert.equal(body.client_secret, 'manifest-secret');
    assert.equal(body.redirect_uri, IDENTITY_URI);
    return json(
      200,
      body.code === 'identity-code'
        ? { access_token: USER_TOKEN_VALUE }
        : { error: 'bad_verification_code' },
    );
  }
  if (url === 'https://api.github.com/user') {
    assert.equal(auth, `Bearer ${USER_TOKEN_VALUE}`);
    return json(200, { id: 583231, login: 'octocat' });
  }
  if (
    url === `https://api.github.com/app/installations/${OURS}/access_tokens`
  ) {
    return verifyAppJwt(auth)
      ? json(201, { token: 'installation-token' })
      : json(401, { message: 'Bad credentials' });
  }
  if (url.startsWith('https://api.github.com/installation/repositories')) {
    assert.equal(auth, 'Bearer installation-token');
    return json(200, {
      repositories: [
        {
          id: 1,
          full_name: 'acme/api',
          private: true,
          html_url: 'https://github.com/acme/api',
        },
      ],
    });
  }
  if (url === 'https://lnbits.test/api/v1/auth') {
    return json(200, { access_token: 'lnbits-admin' });
  }
  if (url === 'https://lnbits.test/users/api/v1/user') {
    return json(200, {
      data: [{ id: 'lnbits-user-1', external_id: 'oid-user' }],
    });
  }
  throw new Error(`unexpected outbound call: ${url}`);
};

let server;
let base;
const realFetch = globalThis.fetch;
const logged = [];
const realConsole = {};

before(async () => {
  globalThis.fetch = stub;
  for (const level of ['log', 'warn', 'error']) {
    realConsole[level] = console[level];
    console[level] = (...args) => {
      logged.push(args.map(String).join(' '));
    };
  }
  await new Promise(resolve => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  calls.length = 0;
  // Each test starts with no recorded installation.
  fs.rmSync(path.join(tempDir, 'connections.json'), { force: true });
});

after(async () => {
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
  await new Promise(resolve => server.close(resolve));
  for (const key of GITHUB_ENV) delete process.env[key];
  delete process.env.ZAPLIE_DATA_DIR;
  const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(path.resolve(tempDir).startsWith(safePrefix), true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// A minimal cookie jar per simulated browser, so the binding cookie travels
// the way a browser would carry it (or, for a link forwarded to someone else,
// doesn't).
const newBrowser = () => new Map();

const remember = (jar, setCookie) => {
  for (const header of setCookie || []) {
    const [pair, ...attributes] = header.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attributes.some(attribute =>
      /^\s*expires=Thu, 01 Jan 1970/i.test(attribute),
    );
    if (expired || !value) {
      jar.delete(name);
    } else {
      jar.set(name, { value, attributes: attributes.map(a => a.trim()) });
    }
  }
};

// node:http, not fetch: the test's own calls must not hit the stub. With a
// jar, the request sends its cookies and the response's Set-Cookie updates it.
const call = (method, route, auth, jar) =>
  new Promise((resolve, reject) => {
    const headers = auth ? { Authorization: auth } : {};
    if (jar && jar.size > 0) {
      headers.Cookie = [...jar]
        .map(([name, cookie]) => `${name}=${cookie.value}`)
        .join('; ');
    }
    const req = http.request(`${base}${route}`, { method, headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        raw += chunk;
      });
      res.on('end', () => {
        if (jar) remember(jar, res.headers['set-cookie']);
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          // Redirects stay null.
        }
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });

const assertBindingCookie = (cookie, cookiePath) => {
  assert.ok(cookie, 'binding cookie set');
  for (const attribute of [
    `Path=${cookiePath}`,
    'Max-Age=600',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ]) {
    assert.ok(cookie.attributes.includes(attribute), attribute);
  }
};

const setupUrl = query => `/api/connections/github/setup?${query}`;

const connected = async token =>
  (await call('GET', '/api/connections/github', `Bearer ${token}`)).body
    .connected;

// Starts an install as `token` in the browser `jar` and returns the install
// link's state.
const startInstall = async (token, jar) => {
  const install = await call(
    'POST',
    '/api/connections/github/install-url',
    `Bearer ${token}`,
    jar,
  );
  return new URL(install.body.installUrl).searchParams.get('state');
};

// Follows GitHub's setup URL redirect in `jar` with `installationId` and
// `state`, returning where the portal sends the browser next.
const returnToSetup = async (installationId, state, jar) => {
  const back = await call(
    'GET',
    setupUrl(
      `installation_id=${installationId}&setup_action=install&state=${state}`,
    ),
    undefined,
    jar,
  );
  assert.equal(back.status, 302);
  return back.headers.location;
};

// Starts an install as `token` and comes back in the same browser.
const installAndReturn = async (token, installationId, jar = newBrowser()) =>
  returnToSetup(installationId, await startInstall(token, jar), jar);

// Starts an identity link as `token` in `jar`; returns GitHub's authorize URL.
const startIdentity = async (token, jar) => {
  const start = await call(
    'POST',
    '/api/identities/github/authorize-url',
    `Bearer ${token}`,
    jar,
  );
  return new URL(start.body.authorizeUrl);
};

const identityCallback = (state, jar) =>
  call(
    'GET',
    `/api/identities/github/callback?code=identity-code&state=${state}`,
    undefined,
    jar,
  );

// No install check may involve a user sign-in or user token.
const assertNoUserAuthorization = () => {
  for (const url of calls) {
    assert.doesNotMatch(url, /login\/oauth|\/user\b|\/user\/installations/);
  }
};

test('setup -> install -> owner-checked connection -> identity link, with no GITHUB_* env vars', async () => {
  // 1. The admin fetches the manifest; installs come back to the setup URL.
  const manifestRes = await call(
    'GET',
    '/api/setup/github/manifest?organization=Acme-Org',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.equal(manifestRes.status, 200);
  assert.match(
    manifestRes.body.action,
    /^https:\/\/github\.com\/organizations\/Acme-Org\/settings\/apps\/new\?state=/,
  );
  const manifest = JSON.parse(manifestRes.body.manifest);
  assert.equal(manifest.setup_url, `${ORIGIN}/api/connections/github/setup`);
  assert.equal(manifest.setup_on_update, true);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.equal(manifest.public, false);
  assert.deepEqual(manifest.callback_urls, [IDENTITY_URI]);
  const manifestState = new URL(manifestRes.body.action).searchParams.get(
    'state',
  );

  // 2. GitHub redirects back with a one-shot code; the conversion is stored,
  // including the owner login the install check compares against.
  const created = await call(
    'GET',
    `/api/setup/github/callback?code=${CODE}&state=${manifestState}`,
  );
  assert.equal(
    created.headers.location,
    `${ORIGIN}/automations?setup=github_created`,
  );
  const stored = JSON.parse(
    fs.readFileSync(path.join(tempDir, 'github-app-credentials.json'), 'utf8'),
  );
  assert.equal(stored.ownerLogin, OWNER);
  const status = await call(
    'GET',
    '/api/setup/github/status',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(status.body.created, true);
  assert.equal(status.body.installationReady, true);
  assert.equal(status.body.source, 'manifest');

  // 3. Install. The install link sets the browser binding cookie, scoped to
  // the connections routes; the same browser returns to GitHub's setup URL,
  // which is checked with the App JWT against the stored owner
  // (case-insensitively) and saved straight away. The cookie is then cleared.
  calls.length = 0;
  const jar = newBrowser();
  const installState = await startInstall(ADMIN_TOKEN, jar);
  assertBindingCookie(jar.get('zaplie_gh_install'), '/api/connections/github');
  const location = await returnToSetup(OURS, installState, jar);
  assert.equal(location, `${SETTINGS}?github=repos_connected`);
  assert.equal(jar.has('zaplie_gh_install'), false, 'cleared after use');
  assert.deepEqual(calls, [`https://api.github.com/app/installations/${OURS}`]);
  assertNoUserAuthorization();
  assert.equal(await connected(ADMIN_TOKEN), true);
  // Recorded against the admin who installed it (tenant-wide: issue 496).
  assert.equal(await connected(USER_TOKEN), false);

  // 4. Repositories are listed with an installation token minted from the
  // stored App key (the stub checks the JWT against the stored key).
  const repos = await call(
    'GET',
    '/api/connections/github/repos',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.equal(repos.status, 200);
  assert.deepEqual(repos.body.repositories, [
    {
      id: 1,
      fullName: 'acme/api',
      private: true,
      htmlUrl: 'https://github.com/acme/api',
    },
  ]);

  // 5. Identity linking with the stored OAuth client (the stub asserts the
  // stored client id and secret), then the lookup the reward flow uses:
  // GitHub numeric id -> Entra oid -> LNbits user.
  // The authorize link sets its own binding cookie, scoped to the identity
  // routes, and the callback clears it.
  const userBrowser = newBrowser();
  const identityUrl = await startIdentity(USER_TOKEN, userBrowser);
  assertBindingCookie(
    userBrowser.get('zaplie_gh_identity'),
    '/api/identities/github',
  );
  assert.equal(identityUrl.searchParams.get('client_id'), 'Iv1.manifest');
  assert.equal(identityUrl.searchParams.get('redirect_uri'), IDENTITY_URI);
  assert.equal(identityUrl.searchParams.has('scope'), false);
  const linked = await identityCallback(
    identityUrl.searchParams.get('state'),
    userBrowser,
  );
  assert.equal(linked.headers.location, `${SETTINGS}?github=connected`);
  assert.equal(userBrowser.has('zaplie_gh_identity'), false, 'cleared');

  const resolved = await call(
    'GET',
    '/api/identities/resolve?provider=github&providerId=583231',
    'test-internal-token',
  );
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.body, {
    personAad: 'oid-user',
    lnbitsUserId: 'lnbits-user-1',
  });
});

test('an install link opened in another browser saves nothing (login CSRF)', async () => {
  // The admin starts an install and forwards the GitHub link. The state is
  // valid, but the browser that comes back did not start the flow.
  const sender = newBrowser();
  const state = await startInstall(ADMIN_TOKEN, sender);
  calls.length = 0;

  // No cookie at all...
  assert.equal(
    await returnToSetup(OURS, state, newBrowser()),
    `${SETTINGS}?github=install_error`,
  );
  // ...or the cookie of another install started in that browser.
  const other = newBrowser();
  await startInstall(ADMIN_TOKEN, other);
  assert.equal(
    await returnToSetup(OURS, state, other),
    `${SETTINGS}?github=install_error`,
  );
  assert.equal(other.has('zaplie_gh_install'), false, 'cleared on failure');

  assert.ok(
    logged.some(line =>
      line.includes('GitHub install returned to a browser that did not start it'),
    ),
  );
  // Refused before GitHub is asked anything.
  assert.deepEqual(calls, []);
  assert.equal(await connected(ADMIN_TOKEN), false);
});

test('an identity link opened in another browser links nothing (login CSRF)', async () => {
  const sender = newBrowser();
  const state = (await startIdentity(ADMIN_TOKEN, sender)).searchParams.get(
    'state',
  );
  const other = newBrowser();
  await startIdentity(USER_TOKEN, other);
  calls.length = 0;

  for (const browser of [newBrowser(), other]) {
    const res = await identityCallback(state, browser);
    assert.equal(res.headers.location, `${SETTINGS}?github=error`);
  }
  assert.equal(other.has('zaplie_gh_identity'), false, 'cleared');
  assert.ok(
    logged.some(line =>
      line.includes(
        'GitHub identity link returned to a browser that did not start it',
      ),
    ),
  );
  // The one-shot code is never exchanged.
  assert.deepEqual(calls, []);
  const mine = await call(
    'GET',
    '/api/identities/mine',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.deepEqual(mine.body, { identities: [] });
});

test('an installation on another account is not saved', async () => {
  const location = await installAndReturn(ADMIN_TOKEN, ELSEWHERE);
  assert.equal(location, `${SETTINGS}?github=install_error`);
  assert.ok(logged.some(line => line.includes('not the App owner')));
  assertNoUserAuthorization();
  assert.equal(await connected(ADMIN_TOKEN), false);
});

test('an id that is not an installation of this App (404) is not saved', async () => {
  const location = await installAndReturn(ADMIN_TOKEN, NOT_OURS);
  assert.equal(location, `${SETTINGS}?github=install_error`);
  assert.ok(logged.some(line => line.includes('(404)')));
  assert.equal(await connected(ADMIN_TOKEN), false);
});

test('a GitHub error during the check saves nothing', async () => {
  const location = await installAndReturn(ADMIN_TOKEN, FAILING);
  assert.equal(location, `${SETTINGS}?github=install_error`);
  assert.ok(
    logged.some(line =>
      line.includes(
        'GitHub installation check failed: installation lookup failed: 502',
      ),
    ),
  );
  assert.equal(await connected(ADMIN_TOKEN), false);
});

test('the setup URL records nothing without our install state', async () => {
  const forged = await call(
    'GET',
    setupUrl(`installation_id=${OURS}&setup_action=install&state=forged`),
  );
  assert.equal(forged.headers.location, `${SETTINGS}?github=install_error`);

  // An identity state is not an install state, nor the reverse, even in the
  // browser that holds both binding cookies.
  const jar = newBrowser();
  const identityState = (await startIdentity(ADMIN_TOKEN, jar)).searchParams.get(
    'state',
  );
  const crossed = await returnToSetup(OURS, identityState, jar);
  assert.equal(crossed, `${SETTINGS}?github=install_error`);
  const installState = await startInstall(ADMIN_TOKEN, jar);
  const identity = await identityCallback(installState, jar);
  assert.equal(identity.status, 400);

  // A repository change made on GitHub itself carries no state of ours.
  const update = await call(
    'GET',
    setupUrl(`installation_id=${OURS}&setup_action=update`),
  );
  assert.equal(update.headers.location, `${SETTINGS}?github=repos_updated`);

  const request = await call('GET', setupUrl('setup_action=request'));
  assert.equal(
    request.headers.location,
    `${SETTINGS}?github=install_requested`,
  );

  // A non-numeric id is refused before GitHub is asked anything, and so is
  // any id that is not canonical: no leading zeros, no zero, at most 15
  // digits. Each comes back in the browser that started its install.
  for (const id of ['..%2F1', '0', `0${OURS}`, '1234567890123456']) {
    const refused = await installAndReturn(ADMIN_TOKEN, id);
    assert.equal(refused, `${SETTINGS}?github=install_error`);
  }

  assert.deepEqual(calls, []);
  assert.equal(await connected(ADMIN_TOKEN), false);
});

test('an env-configured App gets its owner from GET /app, once', async () => {
  const keyPath = path.join(tempDir, 'env-key.pem');
  fs.writeFileSync(keyPath, privateKey);
  process.env.GITHUB_APP_ID = '777';
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
  try {
    assert.equal(
      await installAndReturn(ADMIN_TOKEN, OURS),
      `${SETTINGS}?github=repos_connected`,
    );
    assert.equal(
      await installAndReturn(ADMIN_TOKEN, ELSEWHERE),
      `${SETTINGS}?github=install_error`,
    );
    // Cached per App id: one GET /app for both checks.
    assert.equal(
      calls.filter(url => url === 'https://api.github.com/app').length,
      1,
    );
    assertNoUserAuthorization();
  } finally {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  }
});

test('the GitHub user token is never stored or logged', () => {
  for (const file of fs.readdirSync(tempDir)) {
    const text = fs.readFileSync(path.join(tempDir, file), 'utf8');
    assert.equal(text.includes(USER_TOKEN_VALUE), false, `found in ${file}`);
  }
  for (const line of logged) {
    assert.equal(line.includes(USER_TOKEN_VALUE), false, `logged: ${line}`);
  }
});
