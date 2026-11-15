const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createZapRecordStore, toPayment } = require('./zapRecordStore');

const tempStore = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-records-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { filePath: path.join(dir, 'zap-records.json'), store: createZapRecordStore({ filePath: path.join(dir, 'zap-records.json') }) };
};

test('a payment is recorded once per payment hash and listed newest first', (t) => {
  const { store } = tempStore(t);
  const first = store.record({ paymentHash: 'AB'.repeat(32), amountSats: 5, memo: 'one', timeMs: 1000, from: { oid: 'a' }, to: { oid: 'b' } });
  const replay = store.record({ paymentHash: 'ab'.repeat(32), amountSats: 999, memo: 'other', from: { oid: 'x' }, to: { oid: 'y' } });
  assert.deepEqual(replay, first);
  store.record({ paymentHash: 'cd'.repeat(32), amountSats: 7, memo: 'two', timeMs: 3000, from: { oid: 'a' }, to: { oid: 'b' } });
  assert.deepEqual(store.list().map((entry) => entry.memo), ['two', 'one']);
  assert.deepEqual(store.list({ since: 2 }).map((entry) => entry.memo), ['two']);
  assert.throws(() => store.record({ paymentHash: 'nope', amountSats: 1 }), /payment hash/);
});

test('an unreadable record file is an error, never an empty history', (t) => {
  const { filePath, store } = tempStore(t);
  fs.writeFileSync(filePath, '{ broken');
  assert.throws(() => store.list(), /unreadable/);
});

test('records project into the payment shape the portal reads', () => {
  const zap = toPayment({
    paymentHash: 'ab'.repeat(32),
    kind: 'zap',
    time: 10,
    amountSats: 21,
    memo: 'thanks',
    from: { oid: 'a', displayName: 'Ada', walletId: 'nwc_a' },
    to: { oid: 'b', displayName: 'Bea' },
  });
  assert.equal(zap.amount, -21000);
  assert.equal(zap.wallet_id, 'nwc_a');
  assert.deepEqual(zap.extra, {
    tag: 'zap',
    from: { id: 'nwc_a', name: 'Allowance', user: 'a', displayName: 'Ada' },
    to: { name: 'Private', user: 'b', displayName: 'Bea' },
  });
  const reward = toPayment({
    paymentHash: 'cd'.repeat(32),
    kind: 'reward',
    time: 10,
    amountSats: 5,
    memo: 'PR',
    from: { displayName: 'Automation' },
    to: { oid: 'b', displayName: 'octocat' },
    reward: { eventType: 'githubPrMerged', baseSats: 5 },
  });
  assert.equal(reward.wallet_id, 'treasury');
  assert.equal(reward.extra.automation, true);
  assert.equal(reward.extra.eventType, 'githubPrMerged');
});
