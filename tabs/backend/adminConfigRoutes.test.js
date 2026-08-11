process.env.AAD_APP_TENANT_ID = 'test-tenant';
process.env.AAD_APP_CLIENT_ID = 'test-client';
process.env.REWARDS_MAX_AMOUNT_SATS = '10000';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-admin-config-'));
const testDataFile = path.join(testDirectory, 'data.json');
process.env.ZAPLIE_CONFIG_FILE = testDataFile;

const initialData = {
  rewardName: 'sats',
  botPersona: 'Be concise.',
  rewardAmounts: { githubPrMergedSats: 1000 },
  untouched: { keep: true },
};

jest.mock('./msalValidator', () => ({
  extractBearerToken: (req) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
    return match ? match[1] : null;
  },
  verifyMsalAccessToken: async (token) => {
    if (token === 'admin-token') {
      return { oid: 'admin-oid', roles: ['Zaplie.Admin'] };
    }
    if (token === 'user-token') {
      return { oid: 'user-oid', roles: [] };
    }
    throw new Error('invalid token');
  },
}));

fs.writeFileSync(testDataFile, `${JSON.stringify(initialData, null, 2)}\n`);
const app = require('./server');

let server;
let baseUrl;

beforeAll(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  fs.writeFileSync(testDataFile, `${JSON.stringify(initialData, null, 2)}\n`);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

const call = (method, route, token, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request(
      `${baseUrl}${route}`,
      {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            body: responseBody ? JSON.parse(responseBody) : null,
          });
        });
      },
    );
    request.on('error', reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });

const validConfig = {
  rewardName: 'points',
  botPersona: 'Be warm and specific.',
  rewardAmounts: { githubPrMergedSats: 2500 },
};

describe('admin config access and atomic persistence', () => {
  test('rejects missing, invalid, and non-admin credentials', async () => {
    expect((await call('GET', '/api/admin-config')).status).toBe(401);
    expect((await call('GET', '/api/admin-config', 'invalid-token')).status).toBe(401);
    expect((await call('GET', '/api/admin-config', 'user-token')).status).toBe(403);
  });

  test('returns the complete config only to an administrator', async () => {
    const response = await call('GET', '/api/admin-config', 'admin-token');

    expect(response).toEqual({
      status: 200,
      body: {
        config: {
          rewardName: 'sats',
          botPersona: 'Be concise.',
          rewardAmounts: { githubPrMergedSats: 1000 },
        },
      },
    });
  });

  test('updates all settings in one request and preserves unrelated data', async () => {
    const response = await call('PUT', '/api/admin-config', 'admin-token', validConfig);

    expect(response).toEqual({ status: 200, body: { config: validConfig } });
    expect(JSON.parse(fs.readFileSync(testDataFile, 'utf8'))).toEqual({
      ...initialData,
      ...validConfig,
    });
  });

  test.each([0, -1, 1.5, 10001, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid reward amount %p without changing any setting',
    async (githubPrMergedSats) => {
      const before = fs.readFileSync(testDataFile, 'utf8');
      const response = await call('PUT', '/api/admin-config', 'admin-token', {
        ...validConfig,
        rewardAmounts: { githubPrMergedSats },
      });

      expect(response.status).toBe(400);
      expect(fs.readFileSync(testDataFile, 'utf8')).toBe(before);
    },
  );

  test('reports a failed atomic replacement and leaves the previous file intact', async () => {
    const before = fs.readFileSync(testDataFile, 'utf8');
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated rename failure');
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await call('PUT', '/api/admin-config', 'admin-token', validConfig);

    expect(response.status).toBe(500);
    expect(fs.readFileSync(testDataFile, 'utf8')).toBe(before);
    expect(fs.readdirSync(testDirectory)).toEqual(['data.json']);
    rename.mockRestore();
    consoleError.mockRestore();
  });
});
