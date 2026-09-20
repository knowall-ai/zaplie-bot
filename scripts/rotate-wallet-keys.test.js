const test = require('node:test');
const assert = require('node:assert');

const {
  parseArgs,
  resolveConfig,
  getAccessToken,
  getUsers,
  getUserWallets,
  filterWallets,
  resetWalletKey,
  rotateWalletKeys,
} = require('./rotate-wallet-keys');

test('parseArgs: parses default flags correctly', () => {
  const options = parseArgs([]);
  assert.strictEqual(options.dryRun, false);
  assert.strictEqual(options.allWallets, false);
  assert.deepStrictEqual(options.walletNames, ['Allowance', 'Private']);
  assert.strictEqual(options.userFilter, null);
  assert.strictEqual(options.walletFilter, null);
  assert.strictEqual(options.yes, false);
  assert.strictEqual(options.help, false);
});

test('parseArgs: parses CLI flags and options', () => {
  const options = parseArgs([
    '--dry-run',
    '--all-wallets',
    '--filter',
    'CustomWallet,Allowance',
    '--user',
    'usr_123',
    '--wallet',
    'wal_456',
    '--url',
    'https://lnbits.example.com/',
    '--username',
    'admin',
    '--yes',
  ]);

  assert.strictEqual(options.dryRun, true);
  assert.strictEqual(options.allWallets, true);
  assert.deepStrictEqual(options.walletNames, ['CustomWallet', 'Allowance']);
  assert.strictEqual(options.userFilter, 'usr_123');
  assert.strictEqual(options.walletFilter, 'wal_456');
  assert.strictEqual(options.nodeUrl, 'https://lnbits.example.com/');
  assert.strictEqual(options.username, 'admin');
  assert.strictEqual(options.yes, true);
});

test('parseArgs: supports short flags -n, -u, -w, -y, -h', () => {
  const options = parseArgs(['-n', '-u', 'u1', '-w', 'w1', '-y']);
  assert.strictEqual(options.dryRun, true);
  assert.strictEqual(options.userFilter, 'u1');
  assert.strictEqual(options.walletFilter, 'w1');
  assert.strictEqual(options.yes, true);
});

test('parseArgs: rejects unknown options', () => {
  assert.throws(() => parseArgs(['--unknown-flag']), /Unknown option: --unknown-flag/);
  assert.throws(() => parseArgs(['-x']), /Unknown option: -x/);
});

test('parseArgs: rejects missing option values', () => {
  assert.throws(() => parseArgs(['--filter']), /Missing value for option --filter/);
  assert.throws(() => parseArgs(['--user']), /Missing value for option --user/);
  assert.throws(() => parseArgs(['--wallet']), /Missing value for option --wallet/);
  assert.throws(() => parseArgs(['--url']), /Missing value for option --url/);
  assert.throws(() => parseArgs(['--username']), /Missing value for option --username/);
  assert.throws(() => parseArgs(['--url', '--username']), /Missing value for option --url/);
});

test('parseArgs: rejects --password CLI flag with security guidance', () => {
  assert.throws(
    () => parseArgs(['--password', 'secret']),
    /Passing --password via command-line arguments is disabled for security/,
  );
});

test('resolveConfig: extracts configuration and strips trailing slashes', () => {
  const cfg = resolveConfig({
    nodeUrl: 'https://lnbits.example.com///',
    username: 'admin',
    password: 'password',
  });

  assert.strictEqual(cfg.nodeUrl, 'https://lnbits.example.com');
  assert.strictEqual(cfg.username, 'admin');
  assert.strictEqual(cfg.password, 'password');
  assert.strictEqual(cfg.timeoutMs, 15000);
});

test('resolveConfig: permits HTTP for localhost', () => {
  const local1 = resolveConfig({
    nodeUrl: 'http://localhost:5000',
    username: 'admin',
    password: 'pwd',
  });
  assert.strictEqual(local1.nodeUrl, 'http://localhost:5000');

  const local2 = resolveConfig({
    nodeUrl: 'http://127.0.0.1:5000',
    username: 'admin',
    password: 'pwd',
  });
  assert.strictEqual(local2.nodeUrl, 'http://127.0.0.1:5000');
});

test('resolveConfig: rejects insecure remote HTTP URLs', () => {
  assert.throws(
    () =>
      resolveConfig({
        nodeUrl: 'http://remote.lnbits.com',
        username: 'admin',
        password: 'pwd',
      }),
    /Insecure protocol for LNbits URL.*node URL must use HTTPS/,
  );
});

test('resolveConfig: rejects invalid URL formats', () => {
  assert.throws(
    () =>
      resolveConfig({
        nodeUrl: 'not-a-valid-url',
        username: 'admin',
        password: 'pwd',
      }),
    /Invalid LNbits URL/,
  );
});

test('resolveConfig: throws when nodeUrl is missing', () => {
  assert.throws(
    () => resolveConfig({ nodeUrl: '', username: 'admin', password: 'pwd' }),
    /LNbits URL is not configured/,
  );
});

test('resolveConfig: throws when credentials are missing', () => {
  assert.throws(
    () => resolveConfig({ nodeUrl: 'https://lnbits.com', username: '', password: '' }),
    /LNbits admin credentials missing/,
  );
});

test('filterWallets: filters by default names and excludes deleted', () => {
  const wallets = [
    { id: 'w1', name: 'Allowance', deleted: false },
    { id: 'w2', name: 'Private', deleted: false },
    { id: 'w3', name: 'Savings', deleted: false },
    { id: 'w4', name: 'Allowance', deleted: true },
  ];

  const filtered = filterWallets(wallets);
  assert.strictEqual(filtered.length, 2);
  assert.deepStrictEqual(filtered.map(w => w.id), ['w1', 'w2']);
});

test('filterWallets: respects allWallets and walletFilter options', () => {
  const wallets = [
    { id: 'w1', name: 'Allowance' },
    { id: 'w2', name: 'Private' },
    { id: 'w3', name: 'Custom' },
  ];

  const all = filterWallets(wallets, { allWallets: true });
  assert.strictEqual(all.length, 3);

  const single = filterWallets(wallets, { walletFilter: 'w3' });
  assert.strictEqual(single.length, 1);
  assert.strictEqual(single[0].id, 'w3');
});

test('getAccessToken: requests access token with credentials and timeout signal', async () => {
  let requestedUrl = '';
  let requestedBody = '';
  let hasSignal = false;

  const mockFetch = async (url, init) => {
    requestedUrl = url;
    requestedBody = JSON.parse(init.body);
    hasSignal = Boolean(init.signal);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'test_token_xyz' }),
    };
  };

  const token = await getAccessToken({
    nodeUrl: 'https://lnbits.test',
    username: 'operator',
    password: 'supersecretpassword',
    fetchFn: mockFetch,
  });

  assert.strictEqual(requestedUrl, 'https://lnbits.test/api/v1/auth');
  assert.strictEqual(requestedBody.username, 'operator');
  assert.strictEqual(requestedBody.password, 'supersecretpassword');
  assert.strictEqual(token, 'test_token_xyz');
  assert.strictEqual(hasSignal, true);
});

test('resetWalletKey: calls PUT without bearer token and detects changed keys', async () => {
  let calledUrl = '';
  let calledMethod = '';
  let calledHeaders = {};
  let hasSignal = false;

  const oldKeys = {
    adminkey: 'old_admin_key_111',
    inkey: 'old_invoice_key_222',
  };

  const mockFetch = async (url, init) => {
    calledUrl = url;
    calledMethod = init.method;
    calledHeaders = init.headers;
    hasSignal = Boolean(init.signal);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'w_allowance_1',
        name: 'Allowance',
        user: 'u_user_1',
        adminkey: 'new_admin_key_333',
        inkey: 'new_invoice_key_444',
      }),
    };
  };

  const res = await resetWalletKey({
    nodeUrl: 'https://lnbits.test',
    walletId: 'w_allowance_1',
    userId: 'u_user_1',
    oldKeys,
    fetchFn: mockFetch,
  });

  assert.strictEqual(
    calledUrl,
    'https://lnbits.test/api/v1/wallet/reset/w_allowance_1?usr=u_user_1',
  );
  assert.strictEqual(calledMethod, 'PUT');
  // Crucial check: Authorization header must NOT be sent to allow usr auth
  assert.strictEqual(calledHeaders['Authorization'], undefined);
  assert.strictEqual(hasSignal, true);
  assert.strictEqual(res.adminChanged, true);
  assert.strictEqual(res.invoiceChanged, true);
  assert.strictEqual(res.wallet.adminkey, 'new_admin_key_333');
});

test('resetWalletKey: gives clear actionable error on 401/403 (missing user-id-only auth)', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => 'Not authenticated',
  });

  await assert.rejects(
    () =>
      resetWalletKey({
        nodeUrl: 'https://lnbits.test',
        walletId: 'w1',
        userId: 'u1',
        fetchFn: mockFetch,
      }),
    /AUTH_ALLOWED_METHODS/,
  );
});

test('rotateWalletKeys: dry-run mode does not make PUT calls and requires no confirmation', async () => {
  const putCalls = [];
  const logs = [];

  const mockFetch = async (url, init = {}) => {
    if (init.method === 'PUT') {
      putCalls.push(url);
    }
    if (url.endsWith('/api/v1/auth')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok' }),
      };
    }
    if (url.endsWith('/users/api/v1/user')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'usr_1', username: 'alice', extra: { display_name: 'Alice' } },
        ],
      };
    }
    if (url.includes('/users/api/v1/user/usr_1/wallet')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'w_allowance', name: 'Allowance', user: 'usr_1' },
          { id: 'w_private', name: 'Private', user: 'usr_1' },
        ],
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const summary = await rotateWalletKeys(
    {
      dryRun: true,
      nodeUrl: 'https://lnbits.test',
      username: 'adm',
      password: 'pwd',
    },
    {
      fetchFn: mockFetch,
      logger: { log: msg => logs.push(msg), error: msg => logs.push(msg) },
    },
  );

  assert.strictEqual(putCalls.length, 0);
  assert.strictEqual(summary.targetWalletsFound, 2);
  assert.strictEqual(summary.rotatedWallets, 0);
  assert.strictEqual(summary.results.length, 2);
  assert.strictEqual(summary.results[0].status, 'simulated');
});

test('rotateWalletKeys: live mode fails without confirmation in non-interactive environment', async () => {
  const mockFetch = async (url, init = {}) => {
    if (url.endsWith('/api/v1/auth')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
    }
    if (url.endsWith('/users/api/v1/user')) {
      return { ok: true, status: 200, json: async () => [{ id: 'usr_1' }] };
    }
    if (url.includes('/wallet')) {
      return { ok: true, status: 200, json: async () => [{ id: 'w1', name: 'Allowance', user: 'usr_1' }] };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await assert.rejects(
    () =>
      rotateWalletKeys(
        {
          dryRun: false,
          yes: false,
          nodeUrl: 'https://lnbits.test',
          username: 'adm',
          password: 'pwd',
        },
        {
          fetchFn: mockFetch,
          logger: { log: () => {}, error: () => {} },
        },
      ),
    /Interactive confirmation required to rotate wallet keys live/,
  );
});

test('rotateWalletKeys: user cancellation halts before any wallet reset', async () => {
  let putCalled = false;
  const mockFetch = async (url, init = {}) => {
    if (init.method === 'PUT') {
      putCalled = true;
    }
    if (url.endsWith('/api/v1/auth')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
    }
    if (url.endsWith('/users/api/v1/user')) {
      return { ok: true, status: 200, json: async () => [{ id: 'usr_1' }] };
    }
    if (url.includes('/wallet')) {
      return { ok: true, status: 200, json: async () => [{ id: 'w1', name: 'Allowance', user: 'usr_1' }] };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await assert.rejects(
    () =>
      rotateWalletKeys(
        {
          dryRun: false,
          nodeUrl: 'https://lnbits.test',
          username: 'adm',
          password: 'pwd',
        },
        {
          fetchFn: mockFetch,
          confirmFn: async () => false,
          logger: { log: () => {}, error: () => {} },
        },
      ),
    /Key rotation cancelled by user/,
  );

  assert.strictEqual(putCalled, false);
});

test('rotateWalletKeys: full execution with --yes rotates targeted wallets', async () => {
  const putCalls = [];
  const logs = [];

  const mockFetch = async (url, init = {}) => {
    if (init.method === 'PUT') {
      putCalls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'w_mock',
          adminkey: 'new_adm',
          inkey: 'new_ink',
        }),
      };
    }
    if (url.endsWith('/api/v1/auth')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok' }),
      };
    }
    if (url.endsWith('/users/api/v1/user')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'usr_1', username: 'alice' },
          { id: 'usr_2', username: 'bob' },
        ],
      };
    }
    if (url.includes('/users/api/v1/user/usr_1/wallet')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'w1_allowance', name: 'Allowance', user: 'usr_1', adminkey: 'old1', inkey: 'old2' },
          { id: 'w1_private', name: 'Private', user: 'usr_1', adminkey: 'old3', inkey: 'old4' },
          { id: 'w1_other', name: 'Other', user: 'usr_1' },
        ],
      };
    }
    if (url.includes('/users/api/v1/user/usr_2/wallet')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'w2_allowance', name: 'Allowance', user: 'usr_2', adminkey: 'old5', inkey: 'old6' },
        ],
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const summary = await rotateWalletKeys(
    {
      dryRun: false,
      yes: true,
      nodeUrl: 'https://lnbits.test',
      username: 'adm',
      password: 'pwd',
    },
    {
      fetchFn: mockFetch,
      logger: { log: msg => logs.push(msg), error: msg => logs.push(msg) },
    },
  );

  assert.strictEqual(summary.scannedUsers, 2);
  assert.strictEqual(summary.totalWalletsScanned, 4);
  assert.strictEqual(summary.targetWalletsFound, 3);
  assert.strictEqual(summary.rotatedWallets, 3);
  assert.strictEqual(summary.rotatedByType['Allowance'], 2);
  assert.strictEqual(summary.rotatedByType['Private'], 1);
  assert.strictEqual(summary.skippedWallets, 1);
  assert.strictEqual(summary.errors.length, 0);
  assert.strictEqual(putCalls.length, 3);

  // Security check: ensure raw keys are never present in logger output
  const joinedLogs = logs.join('\n');
  assert.strictEqual(joinedLogs.includes('old1'), false);
  assert.strictEqual(joinedLogs.includes('new_adm'), false);
});

test('rotateWalletKeys: user filter rotates only specified user', async () => {
  const putCalls = [];
  const logs = [];

  const mockFetch = async (url, init = {}) => {
    if (init.method === 'PUT') {
      putCalls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'w', adminkey: 'new', inkey: 'new' }),
      };
    }
    if (url.endsWith('/api/v1/auth')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok' }),
      };
    }
    if (url.endsWith('/users/api/v1/user')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'usr_1', external_id: 'aad_1' },
          { id: 'usr_2', external_id: 'aad_2' },
        ],
      };
    }
    if (url.includes('/users/api/v1/user/usr_2/wallet')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'w2_allowance', name: 'Allowance', user: 'usr_2' },
        ],
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const summary = await rotateWalletKeys(
    {
      userFilter: 'aad_2',
      yes: true,
      nodeUrl: 'https://lnbits.test',
      username: 'adm',
      password: 'pwd',
    },
    {
      fetchFn: mockFetch,
      logger: { log: msg => logs.push(msg), error: msg => logs.push(msg) },
    },
  );

  assert.strictEqual(summary.scannedUsers, 1);
  assert.strictEqual(summary.rotatedWallets, 1);
  assert.strictEqual(putCalls.length, 1);
  assert.strictEqual(putCalls[0].includes('usr=usr_2'), true);
});
