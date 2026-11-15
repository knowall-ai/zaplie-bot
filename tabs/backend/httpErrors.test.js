process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
process.env.AAD_TENANT_ID = '11111111-1111-4111-8111-111111111111';
process.env.AAD_CLIENT_ID = 'test-client';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const app = require('./server');
const { createErrorHandler, scrub } = require('./httpErrors');

let server;
let base;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(() => server.close());

test('an unknown /api or /internal path is a JSON 404, not the app with a 200', async () => {
  for (const [method, path] of [['GET', '/api/nope'], ['POST', '/api/does/not/exist'], ['GET', '/internal/anything'], ['GET', '/api/pending-rewards']]) {
    const response = await fetch(`${base}${path}`, { method, headers: { accept: 'text/html' } });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  }
});

test('the shared token still guards the bot\'s pending-rewards route', async () => {
  const response = await fetch(`${base}/api/pending-rewards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 401);
});

test('a non-page request for an unknown path is a JSON 404', async () => {
  const response = await fetch(`${base}/missing.js`, { headers: { accept: 'application/javascript' } });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});

test('malformed JSON is a JSON 400 with a correlation id and no detail', async () => {
  const response = await fetch(`${base}/api/client-errors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'bad_request');
  assert.match(body.correlationId, /^[0-9A-F]{8}$/);
  assert.equal(JSON.stringify(body).includes('Unexpected'), false);
});

test('a thrown error becomes JSON 500 with a correlation id; the stack stays in the log', async () => {
  const logged = [];
  const probe = express();
  probe.get('/boom', () => {
    throw new Error('database password is hunter2 at /srv/app.js:42');
  });
  probe.use(createErrorHandler({ log: (...args) => logged.push(args.join(' ')) }));
  const probeServer = await new Promise((resolve) => {
    const s = probe.listen(0, () => resolve(s));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${probeServer.address().port}/boom`);
    assert.equal(response.status, 500);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.error, 'internal_error');
    assert.equal(response.headers.get('x-correlation-id'), body.correlationId);
    assert.equal(text.includes('hunter2'), false);
    assert.equal(text.includes('app.js'), false);
    assert.equal(logged.length, 1);
    assert.ok(logged[0].includes(body.correlationId));
    assert.ok(logged[0].includes('hunter2'));
  } finally {
    probeServer.close();
  }
});

test('client error reports are logged by reference, with keys scrubbed', async () => {
  const ok = await fetch(`${base}/api/client-errors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ referenceId: 'AB12CD34', kind: 'render', route: '/wallet', message: 'boom' }),
  });
  assert.equal(ok.status, 204);
  const bad = await fetch(`${base}/api/client-errors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ referenceId: '<script>' }),
  });
  assert.equal(bad.status, 400);
  assert.equal(scrub(`key ${'a'.repeat(32)} nostr+walletconnect://x?secret=y`), 'key [redacted] [redacted]');
});
