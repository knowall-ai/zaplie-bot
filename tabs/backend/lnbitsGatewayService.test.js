const assert = require('node:assert/strict');
const test = require('node:test');
const {
  redactSensitive,
  sanitizePayment,
  sanitizeWallet,
} = require('./lnbitsGatewayService');

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
