const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.IDENTITY_STATE_SECRET = 'test-state-secret';

const {
  signState,
  verifyState,
  signPurposeState,
  verifyPurposeState,
} = require('./githubOAuthState');

test('a purpose state round-trips only for its own purpose', () => {
  const install = signPurposeState('install', ['oid-1', 'hash']);
  const identity = signPurposeState('identity', ['oid-1', 'hash']);

  assert.deepEqual(verifyPurposeState('install', install), ['oid-1', 'hash']);
  assert.deepEqual(verifyPurposeState('identity', identity), ['oid-1', 'hash']);
  assert.equal(verifyPurposeState('identity', install), null);
  assert.equal(verifyPurposeState('install', identity), null);
});

test('plain and purpose states never pass as one another', () => {
  // The manifest callback accepts only the plain 'admin' state.
  const plain = signState('admin');
  for (const purpose of ['identity', 'install']) {
    assert.equal(verifyPurposeState(purpose, plain), null);
    assert.equal(verifyState(signPurposeState(purpose, ['admin', 'h'])), null);
  }
});

test('fields that would break the encoding are refused when signing', () => {
  assert.throws(() => signPurposeState('install', ['oid|1', 'hash']));
  assert.throws(() => signPurposeState('install', ['oid-1']));
  assert.throws(() => signPurposeState('identity', ['oid-1', 'hash', 'extra']));
  assert.throws(() => signPurposeState('install-verify', ['oid-1', '42', 'h']));
});

test('an expired or garbled purpose state is rejected', (t) => {
  const state = signPurposeState('install', ['oid-1', 'hash']);
  t.mock.method(Date, 'now', () => Number.MAX_SAFE_INTEGER);
  assert.equal(verifyPurposeState('install', state), null);
  t.mock.restoreAll();
  assert.equal(verifyPurposeState('install', 'not-a-state'), null);
  assert.equal(verifyPurposeState('install', undefined), null);
});
