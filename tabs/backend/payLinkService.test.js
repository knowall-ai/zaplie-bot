const assert = require('node:assert/strict');
const test = require('node:test');
const {
  allowanceDescription,
  allowanceUsername,
  desiredPayLink,
  findAllowancePayLink,
  publicLnbitsHost,
} = require('./payLinkService');

const OID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
const RANGE = { minSats: 1000, maxSats: 1000, commentChars: 0 };
const WALLET = { id: 'w1', inkey: 'in', adminkey: 'admin' };

test('the username is zaplie- plus the first 12 hex digits of the oid, valid for lnurlp', () => {
  const username = allowanceUsername(OID.toUpperCase());
  assert.equal(username, 'zaplie-0a1b2c3d4e5f');
  assert.match(username, /^[a-z0-9-_.]{1,210}$/);
});

test('the description names the person on one line', () => {
  assert.equal(allowanceDescription('Ada\nLovelace'), 'Zaplie allowance (Ada Lovelace)');
  assert.equal(allowanceDescription(''), 'Zaplie allowance');
});

test('the public host comes from LNBITS_PUBLIC_HOST, else LNBITS_NODE_URL', () => {
  assert.equal(publicLnbitsHost({ LNBITS_PUBLIC_HOST: 'https://Bank.KnowAll.ai/' }), 'bank.knowall.ai');
  assert.equal(publicLnbitsHost({ LNBITS_NODE_URL: 'https://bank.knowall.ai' }), 'bank.knowall.ai');
  assert.equal(publicLnbitsHost({}), '');
});

test('the link is found by username first, then by the description prefix', () => {
  const byUsername = { id: 'a', username: allowanceUsername(OID), description: 'x' };
  const byDescription = { id: 'b', description: 'Zaplie allowance (old)' };
  assert.equal(findAllowancePayLink([byDescription, byUsername], OID), byUsername);
  assert.equal(findAllowancePayLink([{ id: 'c', description: 'Tips' }, byDescription], OID), byDescription);
  assert.equal(findAllowancePayLink([{ id: 'c', description: 'Tips' }], OID), null);
});

