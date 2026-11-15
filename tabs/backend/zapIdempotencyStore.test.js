const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  createZapIdempotencyStore,
  requestDigest,
  scopeDigest,
  __testing: { breakStaleLock },
} = require('./zapIdempotencyStore');

const tempStore = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'zaps.json');
};

const readRecords = (storePath) =>
  JSON.parse(fs.readFileSync(storePath, 'utf8')).records;

const scopeFor = (key) =>
  scopeDigest({ aadObjectId: 'caller-oid', idempotencyKey: key });

const hashFor = (amount) =>
  requestDigest({ recipientUserId: 'recipient-1', amount, memo: 'thanks' });

test('only succeeded records are swept, every other state is kept', async (t) => {
  const storePath = tempStore(t, 'zaplie-zap-ttl-');
  const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      records: {
        [scopeFor('old-success-000001')]: {
          requestHash: hashFor(1),
          state: 'succeeded',
          result: { payment_hash: 'p1', checking_id: 'p1' },
          createdAt: old,
          updatedAt: old,
        },
        [scopeFor('old-failed-0000001')]: {
          requestHash: hashFor(2),
          state: 'failed',
          createdAt: old,
          updatedAt: old,
        },
        // Money may still be in flight for these two, so age is irrelevant.
        [scopeFor('old-pending-000001')]: {
          requestHash: hashFor(3),
          state: 'pending',
          createdAt: old,
          updatedAt: old,
        },
        [scopeFor('old-unknown-000001')]: {
          requestHash: hashFor(4),
          state: 'outcome_unknown',
          payment: { invoiceId: 'invoice-9' },
          createdAt: old,
          updatedAt: old,
        },
      },
    }),
  );

  const store = createZapIdempotencyStore({ storePath });
  await store.begin({ scope: scopeFor('fresh-request-00001'), requestHash: hashFor(5) });

  const records = readRecords(storePath);
  assert.equal(records[scopeFor('old-success-000001')], undefined);
  // A poisoned key has to keep refusing: ageing it out would let a very
  // delayed retry pay for real.
  assert.equal(records[scopeFor('old-failed-0000001')].state, 'failed');
  assert.equal(records[scopeFor('old-pending-000001')].state, 'pending');
  assert.equal(records[scopeFor('old-unknown-000001')].state, 'outcome_unknown');
  assert.equal(records[scopeFor('fresh-request-00001')].state, 'pending');
});

test('the TTL is configurable and a recent record survives the default', async (t) => {
  const storePath = tempStore(t, 'zaplie-zap-ttl-env-');
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const write = () =>
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        records: {
          [scopeFor('ten-days-old-00001')]: {
            requestHash: hashFor(1),
            state: 'succeeded',
            result: { payment_hash: 'p1', checking_id: 'p1' },
            createdAt: tenDaysAgo,
            updatedAt: tenDaysAgo,
          },
        },
      }),
    );

  write();
  const store = createZapIdempotencyStore({ storePath });
  await store.begin({ scope: scopeFor('a-fresh-key-000001'), requestHash: hashFor(9) });
  assert.ok(readRecords(storePath)[scopeFor('ten-days-old-00001')]);

  const original = process.env.ZAP_IDEMPOTENCY_TTL_DAYS;
  t.after(() => {
    if (original === undefined) delete process.env.ZAP_IDEMPOTENCY_TTL_DAYS;
    else process.env.ZAP_IDEMPOTENCY_TTL_DAYS = original;
  });
  process.env.ZAP_IDEMPOTENCY_TTL_DAYS = '5';

  write();
  await store.begin({ scope: scopeFor('b-fresh-key-000001'), requestHash: hashFor(9) });
  assert.equal(readRecords(storePath)[scopeFor('ten-days-old-00001')], undefined);
});

test('a malformed TTL fails the request instead of sweeping the wrong records', async (t) => {
  const storePath = tempStore(t, 'zaplie-zap-ttl-bad-');
  const original = process.env.ZAP_IDEMPOTENCY_TTL_DAYS;
  t.after(() => {
    if (original === undefined) delete process.env.ZAP_IDEMPOTENCY_TTL_DAYS;
    else process.env.ZAP_IDEMPOTENCY_TTL_DAYS = original;
  });
  process.env.ZAP_IDEMPOTENCY_TTL_DAYS = 'soon';

  const store = createZapIdempotencyStore({ storePath });
  await assert.rejects(
    store.begin({ scope: scopeFor('any-key-00000001x'), requestHash: hashFor(1) }),
    (error) => error.status === 503 && /TTL_DAYS/.test(error.message),
  );
});

test('payment identifiers recorded before paying survive a poisoned key', async (t) => {
  const storePath = tempStore(t, 'zaplie-zap-attach-');
  const store = createZapIdempotencyStore({ storePath });
  const scope = scopeFor('attach-key-0000001');
  const requestHash = hashFor(20);

  await store.begin({ scope, requestHash });
  await store.attachPayment({ scope, requestHash, invoiceId: 'invoice-7' });
  await store.fail({ scope, requestHash });

  const record = readRecords(storePath)[scope];
  assert.equal(record.state, 'failed');
  assert.equal(record.payment.invoiceId, 'invoice-7');
});

test('markOutcomeUnknown keeps both identifiers for reconciliation', async (t) => {
  const storePath = tempStore(t, 'zaplie-zap-unknown-store-');
  const store = createZapIdempotencyStore({ storePath });
  const scope = scopeFor('unknown-key-000001');
  const requestHash = hashFor(20);

  await store.begin({ scope, requestHash });
  await store.attachPayment({ scope, requestHash, invoiceId: 'invoice-8' });
  await store.markOutcomeUnknown({
    scope,
    requestHash,
    result: { payment_hash: 'hash-8', checking_id: 'hash-8' },
  });

  const record = readRecords(storePath)[scope];
  assert.equal(record.state, 'outcome_unknown');
  assert.equal(record.payment.invoiceId, 'invoice-8');
  assert.equal(record.payment.paymentHash, 'hash-8');

  // A later begin() must refuse rather than pay again.
  assert.deepEqual(await store.begin({ scope, requestHash }), {
    state: 'outcome_unknown',
    payment: { invoiceId: 'invoice-8', paymentHash: 'hash-8' },
  });
});

test('only one waiter breaks a stale lock', async (t) => {
  const storePath = tempStore(t, 'zaplie-zap-lock-one-');
  const lockPath = `${storePath}.lock`;
  fs.writeFileSync(lockPath, '');
  const observed = fs.statSync(lockPath);

  // Both waiters judged the same lock stale, as two processes racing would.
  await Promise.all([
    breakStaleLock(lockPath, observed),
    breakStaleLock(lockPath, observed),
  ]);

  assert.equal(fs.existsSync(lockPath), false);
  const leftovers = fs
    .readdirSync(path.dirname(lockPath))
    .filter((name) => name.includes('.stale.'));
  assert.deepEqual(leftovers, []);
});

test('a lock taken after the staleness check is not deleted', async (t) => {
  const storePath = tempStore(t, 'zaplie-zap-lock-live-');
  const lockPath = `${storePath}.lock`;
  fs.writeFileSync(lockPath, 'stale');
  const observed = fs.statSync(lockPath);

  // The previous holder released and a new one acquired between our stat and
  // our break. The unlink version of this code deleted the live lock and let a
  // second payer through; the inode check has to refuse instead.
  // The replacement is allocated while the stale file still holds its inode,
  // so the filesystem cannot hand the same one back.
  const incoming = `${lockPath}.incoming`;
  fs.writeFileSync(incoming, 'live');
  fs.unlinkSync(lockPath);
  fs.renameSync(incoming, lockPath);
  assert.notEqual(fs.statSync(lockPath).ino, observed.ino);

  await breakStaleLock(lockPath, observed);

  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'live');
});

test('release leaves a lock that is no longer the one it took', async (t) => {
  const storePath = tempStore(t, 'zaplie-zap-release-real-');
  const lockPath = `${storePath}.lock`;
  const store = createZapIdempotencyStore({ storePath });

  // Wedge the real release path: hold the lock, swap the file underneath it,
  // then let the store's own begin() finish and release.
  let swappedIno = null;
  const original = fs.promises.open;
  t.after(() => {
    fs.promises.open = original;
  });
  fs.promises.open = async (...args) => {
    const handle = await original.apply(fs.promises, args);
    if (args[0] === lockPath && swappedIno === null) {
      // A waiter broke this lock and a new holder took the path.
      const incoming = `${lockPath}.incoming`;
      fs.writeFileSync(incoming, 'new-holder');
      fs.unlinkSync(lockPath);
      fs.renameSync(incoming, lockPath);
      swappedIno = fs.statSync(lockPath).ino;
    }
    return handle;
  };

  await store.begin({
    scope: scopeFor('swapped-lock-00001'),
    requestHash: hashFor(2),
  });

  assert.notEqual(swappedIno, null);
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(fs.statSync(lockPath).ino, swappedIno);
});
