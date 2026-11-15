const assert = require('node:assert/strict');
const test = require('node:test');
const { availableProvisioners, createProvisioner } = require('./walletProvisioner');

test('only registered provisioners can be built, whatever name a request sends', () => {
  assert.deepEqual(availableProvisioners(), ['lnbits']);
  for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'other', 42, undefined]) {
    assert.throws(() => createProvisioner(kind, { token: 'x'.repeat(20) }), (error) => error.status === 400);
  }
  assert.equal(createProvisioner('lnbits', { token: 'lnbits-acl-token-short-lived-0123' }).id, 'lnbits');
});
