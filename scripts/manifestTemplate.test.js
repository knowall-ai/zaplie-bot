const test = require('node:test');
const assert = require('node:assert');

const {
  substitutePlaceholders,
  findUnresolvedPlaceholders,
} = require('./manifestTemplate');

test('substitutes a {{NAME}} placeholder everywhere it appears', () => {
  const json = '{"a":"{{CONTENT_URL}}","b":"{{CONTENT_URL}}/users"}';

  assert.strictEqual(
    substitutePlaceholders(json, { CONTENT_URL: 'https://example.com' }),
    '{"a":"https://example.com","b":"https://example.com/users"}',
  );
});

test('inserts a value containing $ literally', () => {
  // String.replace would expand $&, $` and $1 in the replacement.
  const json = '{"a":"{{CONTENT_URL}}"}';
  const url = 'https://example.com/$&/$1/x$`y';

  assert.strictEqual(
    substitutePlaceholders(json, { CONTENT_URL: url }),
    `{"a":"${url}"}`,
  );
});

test('leaves ${{NAME}} for Teams Toolkit to resolve', () => {
  const json = '{"a":"${{BOT_DOMAIN}}","b":"{{TAB_DOMAIN}}"}';

  assert.strictEqual(
    substitutePlaceholders(json, {
      BOT_DOMAIN: 'nope.example.com',
      TAB_DOMAIN: 'tab.example.com',
    }),
    '{"a":"${{BOT_DOMAIN}}","b":"tab.example.com"}',
  );
});

test('reports only unresolved {{NAME}} placeholders', () => {
  const json = '{"a":"${{BOT_DOMAIN}}","b":"{{TAB_DOMAIN}}","c":"{{TAB_DOMAIN}}"}';

  assert.deepStrictEqual(findUnresolvedPlaceholders(json), ['{{TAB_DOMAIN}}']);
  assert.deepStrictEqual(findUnresolvedPlaceholders('{"a":"done"}'), []);
});
