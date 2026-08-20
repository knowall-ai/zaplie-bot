const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getWalletBalance,
  listWalletPayments,
  redactSensitive,
  resetCachesForTests,
  sanitizePayment,
  sanitizeWallet,
} = require('./lnbitsGatewayService');

const USERS = [
  { id: 'user-1', external_id: 'oid-1' },
  { id: 'user-2', external_id: 'oid-2' },
];
const WALLETS = {
  'user-1': [{ id: 'wallet-1', inkey: 'in-1', adminkey: 'ad-1' }],
  'user-2': [{ id: 'wallet-2', inkey: 'in-2', adminkey: 'ad-2' }],
};

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

const installLnbitsStub = () => {
  process.env.LNBITS_NODE_URL = 'https://lnbits.test';
  process.env.LNBITS_USERNAME = 'service';
  process.env.LNBITS_PASSWORD = 'secret';
  resetCachesForTests();

  const paths = [];
  global.fetch = async (url) => {
    const { pathname } = new URL(url);
    paths.push(pathname);
    if (pathname === '/api/v1/auth') {
      return jsonResponse({ access_token: 'token' });
    }
    if (pathname === '/users/api/v1/user') {
      return jsonResponse(USERS);
    }
    const walletMatch = /^\/users\/api\/v1\/user\/([^/]+)\/wallet$/.exec(pathname);
    if (walletMatch) {
      return jsonResponse(WALLETS[walletMatch[1]] || []);
    }
    if (pathname === '/api/v1/wallet') {
      return jsonResponse({ balance: 5000 });
    }
    if (pathname === '/api/v1/payments') {
      return jsonResponse([]);
    }
    throw new Error(`unexpected LNbits path ${pathname}`);
  };
  return paths;
};

test('wallet serialization excludes LNbits invoice and admin keys', () => {
  const result = sanitizeWallet({
    id: 'wallet-1',
    name: 'Private',
    user: 'user-1',
    balance_msat: 1000,
    deleted: false,
    inkey: 'invoice-key-value',
    adminkey: 'admin-key-value',
  });

  assert.deepEqual(result, {
    id: 'wallet-1',
    name: 'Private',
    user: 'user-1',
    balance_msat: 1000,
    deleted: false,
  });
  assert.equal('inkey' in result, false);
  assert.equal('adminkey' in result, false);
});

test('nested upstream metadata is recursively stripped of sensitive fields', () => {
  const result = redactSensitive({
    public: 'ok',
    nested: {
      token: 'token-value',
      password: 'password-value',
      inkey: 'invoice-key-value',
      adminKey: 'admin-key-value',
      memo: 'visible',
    },
  });

  assert.deepEqual(result, { public: 'ok', nested: { memo: 'visible' } });
});

test('payments without the removed pending flag derive it from status', () => {
  const base = {
    checking_id: 'chk-1',
    payment_hash: 'hash-1',
    amount: -1000,
    fee: 0,
    memo: 'zap',
    time: 123,
    extra: {},
    wallet_id: 'wallet-1',
  };
  assert.equal(sanitizePayment({ ...base, status: 'success' }).pending, false);
  assert.equal(sanitizePayment({ ...base, status: 'pending' }).pending, true);
  assert.equal(sanitizePayment({ ...base, pending: true }).pending, true);
  assert.equal(sanitizePayment(base).pending, false);
});

test('a wallet read is refused when the wallet belongs to somebody else', async () => {
  installLnbitsStub();

  await assert.rejects(getWalletBalance('wallet-2', 'oid-1'), {
    message: 'Wallet does not belong to this account',
    status: 403,
  });
  assert.equal(await getWalletBalance('wallet-1', 'oid-1'), 5);
});

test('parallel payment reads share one walk over the LNbits users', async () => {
  const paths = installLnbitsStub();

  await Promise.all([
    listWalletPayments('wallet-1'),
    listWalletPayments('wallet-2'),
    listWalletPayments('wallet-1'),
  ]);

  assert.equal(paths.filter((p) => p === '/users/api/v1/user').length, 1);
  assert.equal(paths.filter((p) => p.endsWith('/wallet')).length, USERS.length);
});
