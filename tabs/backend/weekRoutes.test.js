process.env.AAD_TENANT_ID = 'test-tenant';
process.env.AAD_CLIENT_ID = 'test-client';
process.env.LNBITS_NODE_URL = 'https://lnbits.test';
process.env.LNBITS_USERNAME = 'lnbits-admin';
process.env.LNBITS_PASSWORD = 'lnbits-password';

// Only the JWKS network fetch is replaced; jwtVerify runs for real against a
// local key pair, so weakening issuer/audience/alg checks makes tests fail.
let mockPublicKey;
jest.mock('jose', () => {
  const actual = jest.requireActual('jose');
  return {
    ...actual,
    createRemoteJWKSet: jest.fn(() => async () => mockPublicKey),
  };
});

const http = require('http');
const { SignJWT, UnsecuredJWT, generateKeyPair } = jest.requireActual('jose');
const app = require('./server');

const OID = 'aad-oid-1';
const ISSUER = 'https://login.microsoftonline.com/test-tenant/v2.0';
const AUDIENCE = 'test-client';

const NOW = Math.floor(Date.now() / 1000);
const SINCE = NOW - 7 * 24 * 60 * 60;

const lnbitsBodies = {
  auth: { access_token: 'lnbits-access-token' },
  users: {
    data: [
      {
        id: 'user-1',
        username: 'ben.weeks@example.com',
        external_id: OID,
        extra: { profileImg: 'img-1', email: 'ben.weeks@example.com' },
      },
      { id: 'user-2', username: 'teammate@example.com', external_id: 'aad-oid-2', extra: {} },
    ],
  },
  wallets: [
    {
      id: 'wallet-1',
      name: 'Allowance',
      user: 'user-1',
      inkey: 'secret-inkey',
      adminkey: 'secret-adminkey',
      deleted: false,
    },
  ],
  payments: [
    { amount: -1000, time: NOW - 60, memo: 'Zap!', extra: { to: { user: 'user-2' } } },
    { amount: -500, time: SINCE - 60, memo: 'old zap', extra: { to: { user: 'user-old' } } },
    { amount: -200, time: NOW - 60, memo: 'Weekly Allowance cleared', extra: { to: { user: 'user-cleared' } } },
    { amount: 3000, time: NOW - 60, memo: 'incoming', extra: { to: { user: 'user-incoming' } } },
  ],
};

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

const mockLnbitsFetch = (overrides = {}) => {
  const bodies = { ...lnbitsBodies, ...overrides };
  global.fetch = jest.fn(async (url) => {
    if (url === 'https://lnbits.test/api/v1/auth') return jsonResponse(bodies.auth);
    if (url === 'https://lnbits.test/users/api/v1/user') return jsonResponse(bodies.users);
    if (url === 'https://lnbits.test/users/api/v1/user/user-1/wallet') {
      return jsonResponse(bodies.wallets);
    }
    if (url === 'https://lnbits.test/api/v1/payments?limit=100') {
      return jsonResponse(bodies.payments);
    }
    throw new Error(`unexpected LNbits url: ${url}`);
  });
};

let privateKey;
let strangerPrivateKey;
let validToken;
let server;
let base;

const signToken = ({ payload = { oid: OID }, issuer = ISSUER, audience = AUDIENCE, key } = {}) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .setIssuer(issuer)
    .setAudience(audience)
    .sign(key || privateKey);

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  mockPublicKey = pair.publicKey;
  strangerPrivateKey = (await generateKeyPair('RS256')).privateKey;
  validToken = await signToken();

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mockLnbitsFetch();
});

const get = (path, auth) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path}`,
      { method: 'GET', headers: auth ? { Authorization: auth } : {} },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      },
    );
    req.on('error', reject);
    req.end();
  });

describe('GET /api/week/zap-history auth', () => {
  test('rejects an anonymous request without touching LNbits', async () => {
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`);
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects a token signed by a key outside the tenant JWKS', async () => {
    const token = await signToken({ key: strangerPrivateKey });
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects a token with the wrong audience', async () => {
    const token = await signToken({ audience: 'some-other-app' });
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects a token with the wrong issuer', async () => {
    const token = await signToken({
      issuer: 'https://login.microsoftonline.com/other-tenant/v2.0',
    });
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects a valid token without an oid claim', async () => {
    const token = await signToken({ payload: { sub: 'someone' } });
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects an unsigned alg:none token', async () => {
    const token = new UnsecuredJWT({ oid: OID })
      .setIssuedAt()
      .setExpirationTime('5m')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .encode();
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects an HS256-signed token', async () => {
    const token = await new SignJWT({ oid: OID })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(new TextEncoder().encode('0'.repeat(32)));
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // Only the algorithms allowlist rejects this: the trusted RSA key verifies
  // RS384 fine, unlike the alg:none and HS256 cases above.
  test('rejects an RS384 token signed with the trusted key', async () => {
    const token = await new SignJWT({ oid: OID })
      .setProtectedHeader({ alg: 'RS384' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(privateKey);
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/week/zap-history', () => {
  test('rejects a missing or non-numeric sinceTs without touching LNbits', async () => {
    const missing = await get('/api/week/zap-history', `Bearer ${validToken}`);
    expect(missing.status).toBe(400);
    const garbage = await get('/api/week/zap-history?sinceTs=abc', `Bearer ${validToken}`);
    expect(garbage.status).toBe(400);
    const empty = await get('/api/week/zap-history?sinceTs=', `Bearer ${validToken}`);
    expect(empty.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('fails loud when LNbits credentials are not configured', async () => {
    const nodeUrl = process.env.LNBITS_NODE_URL;
    delete process.env.LNBITS_NODE_URL;
    try {
      const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${validToken}`);
      expect(res.status).toBe(503);
    } finally {
      process.env.LNBITS_NODE_URL = nodeUrl;
    }
  });

  test('returns the caller zap history using server-side LNbits credentials', async () => {
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${validToken}`);
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.allUsers).toEqual([
      {
        id: 'user-1',
        displayName: 'Ben Weeks',
        profileImg: 'img-1',
        aadObjectId: OID,
        email: 'ben.weeks@example.com',
        type: 'Teammate',
      },
      {
        id: 'user-2',
        displayName: 'Teammate',
        profileImg: '',
        aadObjectId: 'aad-oid-2',
        email: 'teammate@example.com',
        type: 'Teammate',
      },
    ]);
    // Excludes the pre-sinceTs zap, the allowance-clearing sweep and incoming payments.
    expect(body.zappedUserIds).toEqual(['user-2']);

    const authCall = global.fetch.mock.calls.find(
      ([url]) => url === 'https://lnbits.test/api/v1/auth',
    );
    expect(JSON.parse(authCall[1].body)).toEqual({
      username: 'lnbits-admin',
      password: 'lnbits-password',
    });

    const paymentsCall = global.fetch.mock.calls.find(([url]) =>
      url.includes('/api/v1/payments'),
    );
    expect(paymentsCall[1].headers['X-Api-Key']).toBe('secret-inkey');
  });

  test('response never leaks wallet keys', async () => {
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${validToken}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('secret-inkey');
    expect(res.body).not.toContain('secret-adminkey');
    expect(res.body).not.toContain('inkey');
    expect(res.body).not.toContain('adminkey');
  });

  test('derives the user from the token oid, ignoring any client-supplied id', async () => {
    const res = await get(
      `/api/week/zap-history?sinceTs=${SINCE}&userId=user-2`,
      `Bearer ${validToken}`,
    );
    expect(res.status).toBe(200);
    const walletCall = global.fetch.mock.calls.find(([url]) =>
      url.includes('/users/api/v1/user/'),
    );
    expect(walletCall[0]).toBe('https://lnbits.test/users/api/v1/user/user-1/wallet');
  });

  test('responds 502 when the LNbits users response has no data array', async () => {
    mockLnbitsFetch({ users: { users: [] } });
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${validToken}`);
    expect(res.status).toBe(502);
  });

  test('responds 502 when the LNbits wallets response is not an array', async () => {
    mockLnbitsFetch({ wallets: { wallets: [] } });
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${validToken}`);
    expect(res.status).toBe(502);
  });

  test('responds 502 when the LNbits payments response is not an array', async () => {
    mockLnbitsFetch({ payments: { payments: [] } });
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${validToken}`);
    expect(res.status).toBe(502);
  });

  test('returns an empty history when the caller has no LNbits user', async () => {
    mockLnbitsFetch({ users: { data: [lnbitsBodies.users.data[1]] } });
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${validToken}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).zappedUserIds).toEqual([]);
  });

  test('returns an empty history when the caller has no Allowance wallet', async () => {
    mockLnbitsFetch({ wallets: [{ id: 'w', name: 'Private', user: 'user-1', inkey: 'k', deleted: false }] });
    const res = await get(`/api/week/zap-history?sinceTs=${SINCE}`, `Bearer ${validToken}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).zappedUserIds).toEqual([]);
  });
});
