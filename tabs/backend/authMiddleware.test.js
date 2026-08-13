const assert = require('node:assert/strict');
const { after, test } = require('node:test');

const modulePath = require.resolve('./authMiddleware');
const originalToken = process.env.TAB_BACKEND_TOKEN;

const loadMiddleware = token => {
  delete require.cache[modulePath];
  if (token === undefined) {
    delete process.env.TAB_BACKEND_TOKEN;
  } else {
    process.env.TAB_BACKEND_TOKEN = token;
  }
  return require(modulePath);
};

const createResponse = () => ({
  statusCode: 200,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

after(() => {
  delete require.cache[modulePath];
  if (originalToken === undefined) {
    delete process.env.TAB_BACKEND_TOKEN;
  } else {
    process.env.TAB_BACKEND_TOKEN = originalToken;
  }
});

test('fails startup when TAB_BACKEND_TOKEN is missing', () => {
  assert.throws(() => loadMiddleware(undefined), /TAB_BACKEND_TOKEN/);
});

test('fails startup when TAB_BACKEND_TOKEN is the public placeholder', () => {
  assert.throws(
    () => loadMiddleware('your-secret-token'),
    /TAB_BACKEND_TOKEN/,
  );
});

test('accepts only the configured token', () => {
  const middleware = loadMiddleware('real-test-token');

  const wrongResponse = createResponse();
  let wrongNextCalled = false;
  middleware(
    { headers: { authorization: 'wrong-token' } },
    wrongResponse,
    () => {
      wrongNextCalled = true;
    },
  );
  assert.equal(wrongResponse.statusCode, 401);
  assert.equal(wrongNextCalled, false);

  const rightResponse = createResponse();
  let rightNextCalled = false;
  middleware(
    { headers: { authorization: 'real-test-token' } },
    rightResponse,
    () => {
      rightNextCalled = true;
    },
  );
  assert.equal(rightResponse.statusCode, 200);
  assert.equal(rightNextCalled, true);
});
