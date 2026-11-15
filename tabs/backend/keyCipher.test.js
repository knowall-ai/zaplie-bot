const assert = require('node:assert/strict');
const test = require('node:test');
const { createKeyCipher } = require('./keyCipher');

const withEnv = (t, values) => {
  const names = ['ZAPLIE_STORE_KEY', 'NODE_ENV', 'WEBSITE_SITE_NAME'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  for (const name of names) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
};

test('a deployed backend refuses to seal keys without ZAPLIE_STORE_KEY', (t) => {
  for (const deployed of [{ NODE_ENV: 'production' }, { WEBSITE_SITE_NAME: 'zaplie-prod-webapp' }]) {
    withEnv(t, deployed);
    assert.throws(() => createKeyCipher().encrypt('a'.repeat(32)), /ZAPLIE_STORE_KEY must be set/);
  }
});

test('a deployed backend seals and opens keys with ZAPLIE_STORE_KEY', (t) => {
  withEnv(t, { WEBSITE_SITE_NAME: 'zaplie-prod-webapp', ZAPLIE_STORE_KEY: 'c'.repeat(64) });
  const cipher = createKeyCipher();
  const sealed = cipher.encrypt('a'.repeat(32));
  assert.ok(cipher.isSealed(sealed));
  assert.equal(sealed.includes('a'.repeat(32)), false);
  assert.equal(cipher.decrypt(sealed), 'a'.repeat(32));
});

test('a malformed ZAPLIE_STORE_KEY is refused, never padded or truncated', (t) => {
  withEnv(t, { ZAPLIE_STORE_KEY: 'not-hex' });
  assert.throws(() => createKeyCipher().encrypt('a'.repeat(32)), /64 hexadecimal characters/);
});
