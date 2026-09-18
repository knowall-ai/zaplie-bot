const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PROVISIONING_FAILED_MESSAGE,
  callerDisplayName,
  createEnsureCaller,
  createLnbitsUser,
  fundAllowanceWallet,
  initialAllowance,
  listUserWallets,
  repairCallerWallets,
  resetCachesForTests,
} = require('./lnbitsGatewayService');

const withLnbitsEnvironment = (t, overrides = {}) => {
  const keys = [
    'LNBITS_NODE_URL',
    'LNBITS_USERNAME',
    'LNBITS_PASSWORD',
    'LNBITS_INITIAL_ALLOWANCE',
    'PROFILE_PHOTO_HOST',
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = global.fetch;
  Object.assign(process.env, {
    LNBITS_NODE_URL: 'https://lnbits.test',
    LNBITS_USERNAME: 'test-user',
    LNBITS_PASSWORD: 'test-password',
    ...overrides,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  t.after(() => {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    resetCachesForTests();
  });
  resetCachesForTests();
};

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

const emptyResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'text/plain' },
  json: async () => {
    throw new Error('the delete response has no body');
  },
});

// Records every LNbits call so a test can assert the exact provisioning traffic.
const recordingLnbits = (
  requests,
  { wallets = [], users = [], deleteStatus = 200 } = {},
) => {
  const created = [...wallets];
  const directory = [...users];
  return async (url, options = {}) => {
    const path = String(url).replace('https://lnbits.test', '');
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push([method, path, body]);

    if (path === '/api/v1/auth') {
      return jsonResponse({ access_token: 'token-1' });
    }
    if (path === '/users/api/v1/user' && method === 'POST') {
      const user = { id: 'user-new', ...body };
      directory.push(user);
      return jsonResponse(user);
    }
    if (path === '/users/api/v1/user' && method === 'GET') {
      return jsonResponse(directory);
    }
    const deleted = /^\/users\/api\/v1\/user\/([^/]+)$/.exec(path);
    if (deleted && method === 'DELETE') {
      if (deleteStatus >= 400) {
        return jsonResponse({ detail: 'nope' }, deleteStatus);
      }
      const index = directory.findIndex((user) => user.id === deleted[1]);
      if (index >= 0) directory.splice(index, 1);
      return emptyResponse();
    }
    const owner = /^\/users\/api\/v1\/user\/([^/]+)\/wallet$/.exec(path);
    if (owner) {
      if (method === 'POST') {
        const wallet = {
          id: `wallet-${created.length + 1}`,
          name: body.name,
          user: owner[1],
          inkey: `inkey-${created.length + 1}`,
          adminkey: `adminkey-${created.length + 1}`,
          balance_msat: 0,
        };
        created.push(wallet);
        return jsonResponse(wallet, 201);
      }
      return jsonResponse(created.filter((wallet) => wallet.user === owner[1]));
    }
    if (path === '/users/api/v1/balance' && method === 'PUT') {
      return jsonResponse({ id: body.id, balance: body.amount });
    }
    throw new Error(`unexpected LNbits call: ${method} ${path}`);
  };
};

test('a first-time caller gets an LNbits account, both wallets and the allowance', async (t) => {
  withLnbitsEnvironment(t, {
    LNBITS_INITIAL_ALLOWANCE: '500',
    PROFILE_PHOTO_HOST: 'contoso.sharepoint.com',
  });
  const requests = [];
  global.fetch = recordingLnbits(requests);

  const ensureCaller = createEnsureCaller({
    findLinkedUserForCaller: async () => null,
  });
  const result = await ensureCaller({
    aadObjectId: 'entra-oid-1',
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
    userPrincipalName: 'ada@example.com',
  });

  assert.equal(result.provisioned, true);
  assert.equal(result.user.id, 'user-new');
  assert.deepEqual(result.funding, {
    funded: true,
    amount: 500,
    skipReason: null,
    configurationError: false,
  });

  const createUserCall = requests.find(
    ([method, path]) => method === 'POST' && path === '/users/api/v1/user',
  );
  // The Entra object id is the link the bot writes, and the extra payload has to
  // satisfy both readers so the account is indistinguishable from a bot one.
  assert.equal(createUserCall[2].external_id, 'entra-oid-1');
  assert.equal(createUserCall[2].email, 'ada@example.com');
  assert.deepEqual(createUserCall[2].extra, {
    display_name: 'Ada Lovelace',
    picture:
      'https://contoso.sharepoint.com/_layouts/15/userphoto.aspx?AccountName=ada%40example.com',
    profileImg:
      'https://contoso.sharepoint.com/_layouts/15/userphoto.aspx?AccountName=ada%40example.com',
    aadObjectId: 'entra-oid-1',
    email: 'ada@example.com',
    type: 'Teammate',
    userType: 'teammate',
  });

  assert.deepEqual(
    requests
      .filter(([method, path]) => method === 'POST' && path.endsWith('/wallet'))
      .map(([, , body]) => body.name),
    ['Private', 'Allowance'],
  );
  assert.deepEqual(
    requests.find(([, path]) => path === '/users/api/v1/balance')[2],
    { id: result.wallets.allowanceWallet.id, amount: 500 },
  );
});

test('provisioning still succeeds, and flags itself, when no allowance is configured', async (t) => {
  withLnbitsEnvironment(t, { LNBITS_INITIAL_ALLOWANCE: undefined });
  const requests = [];
  global.fetch = recordingLnbits(requests);

  const result = await createEnsureCaller({
    findLinkedUserForCaller: async () => null,
  })({ aadObjectId: 'entra-oid-2', displayName: 'Grace Hopper' });

  assert.equal(result.provisioned, true);
  assert.deepEqual(result.funding, {
    funded: false,
    amount: 0,
    skipReason: 'LNBITS_INITIAL_ALLOWANCE is not set',
    // Absent is a deployment choice, not an operator mistake.
    configurationError: false,
  });
  assert.equal(
    requests.some(([, path]) => path === '/users/api/v1/balance'),
    false,
  );
  // The wallets exist regardless: an unfunded account still beats a 403.
  assert.equal(result.wallets.privateWallet.name, 'Private');
  assert.equal(result.wallets.allowanceWallet.name, 'Allowance');
});

test('a failed top-up flags the account instead of failing provisioning', async (t) => {
  withLnbitsEnvironment(t, { LNBITS_INITIAL_ALLOWANCE: '500' });
  global.fetch = async (url, options = {}) => {
    const path = String(url).replace('https://lnbits.test', '');
    if (path === '/users/api/v1/balance') {
      return jsonResponse({ detail: 'nope' }, 500);
    }
    return recordingLnbits([])(url, options);
  };

  const result = await createEnsureCaller({
    findLinkedUserForCaller: async () => null,
  })({ aadObjectId: 'entra-oid-3', displayName: 'Alan Turing' });

  assert.equal(result.provisioned, true);
  assert.equal(result.funding.funded, false);
  assert.match(result.funding.skipReason, /initial allowance top-up failed/);
});

const withAllowance = async (value, assertion) => {
  const original = process.env.LNBITS_INITIAL_ALLOWANCE;
  try {
    if (value === undefined) delete process.env.LNBITS_INITIAL_ALLOWANCE;
    else process.env.LNBITS_INITIAL_ALLOWANCE = value;
    await assertion();
  } finally {
    if (original === undefined) delete process.env.LNBITS_INITIAL_ALLOWANCE;
    else process.env.LNBITS_INITIAL_ALLOWANCE = original;
  }
};

test('an absent allowance provisions unfunded without blaming the operator', async () => {
  for (const absent of [undefined, '', '   ']) {
    await withAllowance(absent, () => {
      assert.deepEqual(initialAllowance(), {
        amount: 0,
        skipReason: 'LNBITS_INITIAL_ALLOWANCE is not set',
        configurationError: false,
      });
    });
  }
});

test('a malformed allowance is a configuration error, not a plain skip', async () => {
  // Same "positive integer" rule the rest of the backend applies to sat
  // amounts, so '500abc' is rejected instead of being read as 500.
  for (const malformed of ['500abc', 'lots', '0', '-1', '1.5']) {
    await withAllowance(malformed, () => {
      assert.deepEqual(initialAllowance(), {
        amount: 0,
        skipReason: `LNBITS_INITIAL_ALLOWANCE must be a positive integer (${malformed})`,
        configurationError: true,
      });
    });
  }

  await withAllowance('21', () => {
    assert.deepEqual(initialAllowance(), {
      amount: 21,
      skipReason: null,
      configurationError: false,
    });
  });
});

test('a malformed allowance is logged as an error, an absent one only warned', async (t) => {
  const levels = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (message) => levels.push(['warn', message]);
  console.error = (message) => levels.push(['error', message]);
  t.after(() => {
    console.warn = originalWarn;
    console.error = originalError;
  });

  await withAllowance('500abc', async () => {
    const result = await fundAllowanceWallet('wallet-1');
    assert.equal(result.configurationError, true);
    assert.equal(levels.at(-1)[0], 'error');
    assert.match(levels.at(-1)[1], /must be a positive integer \(500abc\)/);
  });
  await withAllowance(undefined, async () => {
    const result = await fundAllowanceWallet('wallet-1');
    assert.equal(result.configurationError, false);
    assert.equal(levels.at(-1)[0], 'warn');
  });
});

test('simultaneous first requests create exactly one user and one funding', async () => {
  let createCalls = 0;
  let walletCalls = 0;
  let fundingCalls = 0;
  const ensureCaller = createEnsureCaller({
    findLinkedUserForCaller: async () => null,
    createUserForCaller: async () => {
      createCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { id: 'user-new' };
    },
    ensureWalletsForCaller: async () => {
      walletCalls += 1;
      return {
        privateWallet: { id: 'wallet-private', name: 'Private' },
        allowanceWallet: { id: 'wallet-allowance', name: 'Allowance' },
        allowanceCreated: true,
      };
    },
    fundAllowanceForCaller: async () => {
      fundingCalls += 1;
      return { funded: true, amount: 500, skipReason: null };
    },
    invalidateForCaller: () => {},
    // The cross-instance duplicate check has its own tests below; here the
    // point is that one process creates one user.
    resolveDuplicateForCaller: async (_aadObjectId, created) => created,
  });

  const profile = { aadObjectId: 'entra-oid-4', displayName: 'Ada Lovelace' };
  const results = await Promise.all([
    ensureCaller(profile),
    ensureCaller(profile),
    ensureCaller(profile),
  ]);

  assert.equal(createCalls, 1);
  assert.equal(walletCalls, 1);
  assert.equal(fundingCalls, 1);
  assert.deepEqual(
    results.map((result) => result.user.id),
    ['user-new', 'user-new', 'user-new'],
  );
});

test('a user linked between the lookup and the lock is reused, not duplicated', async () => {
  let lookups = 0;
  let createCalls = 0;
  const ensureCaller = createEnsureCaller({
    // First lookup misses, the re-check inside the critical section hits.
    findLinkedUserForCaller: async () => {
      lookups += 1;
      return lookups === 1 ? null : { id: 'user-existing' };
    },
    createUserForCaller: async () => {
      createCalls += 1;
      return { id: 'user-new' };
    },
  });

  const result = await ensureCaller({ aadObjectId: 'entra-oid-5' });

  assert.equal(createCalls, 0);
  assert.deepEqual(result, {
    user: { id: 'user-existing' },
    provisioned: false,
    funding: null,
  });
});

test('an already linked user is returned untouched', async () => {
  let createCalls = 0;
  let walletCalls = 0;
  const ensureCaller = createEnsureCaller({
    findLinkedUserForCaller: async () => ({ id: 'user-1', external_id: 'oid-1' }),
    createUserForCaller: async () => {
      createCalls += 1;
      return { id: 'user-new' };
    },
    ensureWalletsForCaller: async () => {
      walletCalls += 1;
      return {};
    },
  });

  const result = await ensureCaller({ aadObjectId: 'oid-1' });

  assert.equal(createCalls, 0);
  assert.equal(walletCalls, 0);
  assert.equal(result.provisioned, false);
  assert.equal(result.user.id, 'user-1');
});

test('an unauthenticated caller is rejected before anything is created', async () => {
  let createCalls = 0;
  let lookups = 0;
  const ensureCaller = createEnsureCaller({
    findLinkedUserForCaller: async () => {
      lookups += 1;
      return null;
    },
    createUserForCaller: async () => {
      createCalls += 1;
      return { id: 'user-new' };
    },
  });

  for (const input of [undefined, null, {}, { aadObjectId: '' }, { aadObjectId: 7 }]) {
    await assert.rejects(
      ensureCaller(input),
      (error) =>
        error.status === 403 && /No LNbits user is linked/.test(error.message),
    );
  }
  assert.equal(lookups, 0);
  assert.equal(createCalls, 0);
});

test('a provisioning failure surfaces actionable copy, not a raw 403', async () => {
  const ensureCaller = createEnsureCaller({
    findLinkedUserForCaller: async () => null,
    createUserForCaller: async () => {
      throw new Error('LNbits request failed with status 500');
    },
  });

  await assert.rejects(
    ensureCaller({ aadObjectId: 'entra-oid-6' }),
    (error) =>
      error.status === 503 &&
      error.expose === true &&
      error.message === PROVISIONING_FAILED_MESSAGE,
  );
});

// The reachable path: ensureCaller short-circuits for an already linked user,
// so the repair has to hang off the caller's own wallet listing — which is what
// lnbitsRoutes calls for GET /users/:id/wallets.
const halfProvisioned = (requests, name) =>
  recordingLnbits(requests, {
    wallets: [
      {
        id: 'wallet-existing',
        name,
        user: 'user-half',
        inkey: 'inkey-existing',
        adminkey: 'adminkey-existing',
        balance_msat: 0,
      },
    ],
  });

test('listing a healthy account costs no extra LNbits call', async (t) => {
  withLnbitsEnvironment(t, { LNBITS_INITIAL_ALLOWANCE: '500' });
  global.fetch = async () => {
    throw new Error('a healthy account must not trigger any repair traffic');
  };

  const wallets = [
    { id: 'wallet-1', name: 'Private' },
    { id: 'wallet-2', name: 'Allowance' },
  ];
  assert.deepEqual(await repairCallerWallets('user-healthy', wallets), wallets);
});

test('a half-provisioned account is repaired when its own wallets are listed', async (t) => {
  withLnbitsEnvironment(t, { LNBITS_INITIAL_ALLOWANCE: '500' });
  const requests = [];
  // Only the Private wallet made it: creating the Allowance wallet failed after
  // the LNbits user was created, and ensureCaller will never revisit it.
  global.fetch = halfProvisioned(requests, 'Private');

  const listed = await listUserWallets('user-half');
  assert.deepEqual(
    listed.map((wallet) => wallet.name),
    ['Private'],
  );

  const repaired = await repairCallerWallets('user-half', listed);

  assert.deepEqual(
    repaired.map((wallet) => wallet.name),
    ['Private', 'Allowance'],
  );
  assert.deepEqual(
    requests
      .filter(([method, path]) => method === 'POST' && path.endsWith('/wallet'))
      .map(([, , body]) => body.name),
    ['Allowance'],
  );
  // The wallet it just created is funded, finishing the interrupted opening
  // allowance rather than refilling anything.
  assert.deepEqual(
    requests.find(([, path]) => path === '/users/api/v1/balance')[2],
    { id: repaired.at(-1).id, amount: 500 },
  );
});

test('repair reuses an existing allowance wallet and never re-funds it', async (t) => {
  withLnbitsEnvironment(t, { LNBITS_INITIAL_ALLOWANCE: '500' });
  const requests = [];
  // A hand-renamed lower-case wallet still counts as the Allowance wallet.
  global.fetch = halfProvisioned(requests, 'allowance');

  const repaired = await repairCallerWallets(
    'user-half',
    await listUserWallets('user-half'),
  );

  assert.deepEqual(
    repaired.map((wallet) => wallet.name),
    ['allowance', 'Private'],
  );
  assert.deepEqual(
    requests
      .filter(([method, path]) => method === 'POST' && path.endsWith('/wallet'))
      .map(([, , body]) => body.name),
    ['Private'],
  );
  assert.equal(
    requests.some(([, path]) => path === '/users/api/v1/balance'),
    false,
  );
});

test('a failed repair still returns the wallets the account does have', async (t) => {
  withLnbitsEnvironment(t, { LNBITS_INITIAL_ALLOWANCE: '500' });
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  global.fetch = async (url, options = {}) => {
    const path = String(url).replace('https://lnbits.test', '');
    if (path === '/api/v1/auth') {
      return jsonResponse({ access_token: 'token-1' });
    }
    if (options.method === 'POST') {
      return jsonResponse({ detail: 'nope' }, 500);
    }
    return jsonResponse([]);
  };

  const wallets = [{ id: 'wallet-1', name: 'Private' }];
  assert.deepEqual(await repairCallerWallets('user-half', wallets), wallets);
});

test('a second instance racing the same oid leaves exactly one LNbits user', async (t) => {
  withLnbitsEnvironment(t, { LNBITS_INITIAL_ALLOWANCE: '500' });
  const requests = [];
  // The other portal instance already created its user for this oid: the
  // in-flight map is per-process, so this one only finds out after creating.
  global.fetch = recordingLnbits(requests, {
    users: [{ id: 'user-winner', external_id: 'entra-oid-race' }],
  });

  const result = await createEnsureCaller({
    findLinkedUserForCaller: async () => null,
  })({ aadObjectId: 'entra-oid-race', displayName: 'Ada Lovelace' });

  assert.equal(result.user.id, 'user-winner');
  assert.equal(result.provisioned, false);
  assert.deepEqual(
    requests.filter(([method]) => method === 'DELETE'),
    [['DELETE', '/users/api/v1/user/user-new', undefined]],
  );
  // The duplicate is gone before any wallet or funding call is made for it.
  assert.equal(
    requests.some(([, path]) => /\/wallet$|\/balance$/.test(path)),
    false,
  );
});

test('a duplicate that cannot be deleted is logged loudly', async (t) => {
  withLnbitsEnvironment(t, { LNBITS_INITIAL_ALLOWANCE: '500' });
  const errors = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (message) => errors.push(message);
  console.warn = () => {};
  t.after(() => {
    console.error = originalError;
    console.warn = originalWarn;
  });
  global.fetch = recordingLnbits([], {
    users: [{ id: 'user-winner', external_id: 'entra-oid-race-2' }],
    deleteStatus: 500,
  });

  const result = await createEnsureCaller({
    findLinkedUserForCaller: async () => null,
  })({ aadObjectId: 'entra-oid-race-2', displayName: 'Ada Lovelace' });

  assert.equal(result.user.id, 'user-winner');
  assert.match(
    errors.join('\n'),
    /could not delete duplicate LNbits user user-new .*until the duplicate is removed by hand/s,
  );
});

test('a caller with no name claim is never labelled with their Entra GUID', () => {
  const oid = '8f14e45f-ceea-467a-9f1e-c6d0f6a4b1d2';

  assert.equal(
    callerDisplayName(oid, { displayName: 'Ada Lovelace', email: 'ada@x.com' }),
    'Ada Lovelace',
  );
  assert.equal(
    callerDisplayName(oid, { displayName: '   ', email: 'ada@x.com' }),
    'ada',
  );
  assert.equal(callerDisplayName(oid, { userPrincipalName: 'grace@x.com' }), 'grace');
  // Neither claim: a readable label with a short suffix, never the GUID.
  assert.equal(callerDisplayName(oid, {}), 'Teammate b1d2');
  assert.equal(callerDisplayName(oid), 'Teammate b1d2');
  assert.equal(callerDisplayName(oid, { email: '  ' }).includes(oid), false);
});

test('no avatar is fabricated when the tenant photo host is unset', async (t) => {
  withLnbitsEnvironment(t, { PROFILE_PHOTO_HOST: undefined });
  const requests = [];
  global.fetch = recordingLnbits(requests);

  await createEnsureCaller({ findLinkedUserForCaller: async () => null })({
    aadObjectId: 'entra-oid-8',
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
    userPrincipalName: 'ada@example.com',
  });

  const created = requests.find(
    ([method, path]) => method === 'POST' && path === '/users/api/v1/user',
  );
  assert.equal(created[2].extra.profileImg, '');
  assert.equal(created[2].extra.picture, '');
});

test('createLnbitsUser rejects a malformed LNbits response', async (t) => {
  withLnbitsEnvironment(t);
  global.fetch = async (url) =>
    String(url).endsWith('/api/v1/auth')
      ? jsonResponse({ access_token: 'token-1' })
      : jsonResponse({ detail: 'created' });

  await assert.rejects(
    createLnbitsUser({ aadObjectId: 'oid-7', displayName: 'Nobody' }),
    /user creation response is malformed/,
  );
});

test('an unfunded wallet is reported when the allowance is unset', async (t) => {
  withLnbitsEnvironment(t, { LNBITS_INITIAL_ALLOWANCE: undefined });
  global.fetch = async () => {
    throw new Error('no LNbits call is expected without an allowance');
  };

  assert.deepEqual(await fundAllowanceWallet('wallet-1'), {
    funded: false,
    amount: 0,
    skipReason: 'LNBITS_INITIAL_ALLOWANCE is not set',
    configurationError: false,
  });
});
