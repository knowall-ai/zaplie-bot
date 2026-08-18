const test = require('node:test');
const assert = require('node:assert/strict');
const { findUniqueUserByAadObjectId, parseExtra } = require('./lnbitsUserDirectory');

test('parses object and JSON-string LNbits user metadata', () => {
  assert.deepEqual(parseExtra({ extra: { aadObjectId: 'aad-1' } }), {
    aadObjectId: 'aad-1',
  });
  assert.deepEqual(parseExtra({ extra: '{"aadObjectId":"aad-2"}' }), {
    aadObjectId: 'aad-2',
  });
  assert.deepEqual(parseExtra({ extra: 'not-json' }), {});
});

test('finds a user by application-level aadObjectId metadata', () => {
  const users = [
    { id: 'user-1', extra: { aadObjectId: 'aad-1' } },
    { id: 'user-2', extra: { aadObjectId: 'aad-2' } },
  ];

  assert.equal(findUniqueUserByAadObjectId(users, 'aad-2'), users[1]);
  assert.equal(findUniqueUserByAadObjectId(users, 'aad-missing'), null);
});

test('finds an LNbits v1 user by external_id', () => {
  const users = [
    { id: 'user-1', external_id: 'aad-1' },
    { id: 'user-2', external_id: 'aad-2' },
  ];

  assert.equal(findUniqueUserByAadObjectId(users, 'aad-2'), users[1]);
});

test('fails loud for malformed or ambiguous directory data', () => {
  assert.throws(
    () => findUniqueUserByAadObjectId(null, 'aad-1'),
    /LNbits users response is not an array/,
  );
  assert.throws(
    () =>
      findUniqueUserByAadObjectId(
        [
          { id: 'user-1', extra: { aadObjectId: 'aad-1' } },
          { id: 'user-2', aadObjectId: 'aad-1' },
        ],
        'aad-1',
      ),
    /More than one LNbits user is linked/,
  );
});
