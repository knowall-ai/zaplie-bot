// filepath: tabs/backend/zapRecordStore.js
// Zaplie's own record of every zap and automation reward it paid, keyed by
// payment hash. With NWC there is no way to attach LNbits payment `extra`, so
// this is where "who zapped whom, why" lives; the feed, the leaderboards, the
// reports and the automation stats read it (the gateway projects records into
// the payment shape the portal already understands).
//
// One JSON file under ZAPLIE_DATA_DIR, written atomically. Only names, Entra
// ids, amounts and memos: never a key or a connection string.
const fs = require('fs');
const { dataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');

const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_MEMO = 500;

const clean = (value, max = 256) => (typeof value === 'string' ? value.slice(0, max) : null);

const createZapRecordStore = ({ filePath = dataPath('zap-records.json'), now = () => Date.now() } = {}) => {
  const read = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.records)) throw new Error('malformed');
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, records: [] };
      throw Object.assign(new Error(`zap records are unreadable: ${error.message}`), { status: 500 });
    }
  };

  /**
   * Records one payment. Idempotent per payment hash: a replayed record is
   * returned as stored, never duplicated.
   */
  const record = (input) => {
    if (!HASH_PATTERN.test(String(input.paymentHash || ''))) {
      throw new Error('a zap record needs the payment hash');
    }
    const store = read();
    const paymentHash = input.paymentHash.toLowerCase();
    const existing = store.records.find((entry) => entry.paymentHash === paymentHash);
    if (existing) return existing;
    const entry = {
      paymentHash,
      kind: input.kind === 'reward' ? 'reward' : 'zap',
      source: clean(input.source, 32) || 'portal',
      time: Math.floor((input.timeMs ?? now()) / 1000),
      amountSats: Number(input.amountSats),
      memo: clean(input.memo, MAX_MEMO) || '',
      from: {
        oid: clean(input.from?.oid, 64),
        displayName: clean(input.from?.displayName) || '',
        walletId: clean(input.from?.walletId, 64),
      },
      to: {
        oid: clean(input.to?.oid, 64),
        displayName: clean(input.to?.displayName) || '',
      },
      ...(input.reward && typeof input.reward === 'object'
        ? {
            reward: Object.fromEntries(
              ['eventType', 'repo', 'source', 'baseSats', 'bonusSats', 'level']
                .filter((key) => input.reward[key] !== undefined)
                .map((key) => [key, input.reward[key]]),
            ),
          }
        : {}),
    };
    store.records.push(entry);
    writeJsonSecure(filePath, store);
    return entry;
  };

  /** Records newest first, optionally only those at or after `since` (Unix seconds). */
  const list = ({ since } = {}) =>
    read()
      .records.filter((entry) => !since || entry.time >= since)
      .sort((a, b) => b.time - a.time);

  const byPaymentHash = () => new Map(read().records.map((entry) => [entry.paymentHash, entry]));

  return { record, list, byPaymentHash };
};

/**
 * A record in the LNbits payment shape the portal's feed, leaderboard and
 * transaction log already read (`extra.tag`, `extra.from`, `extra.to.user`).
 * Sent from the sender's Allowance wallet, or from the Treasury for a reward.
 */
const toPayment = (entry) => ({
  checking_id: entry.paymentHash,
  payment_hash: entry.paymentHash,
  pending: false,
  amount: -entry.amountSats * 1000,
  fee: 0,
  memo: entry.memo,
  time: entry.time,
  wallet_id: entry.from.walletId || (entry.kind === 'reward' ? 'treasury' : ''),
  extra: {
    tag: 'zap',
    ...(entry.kind === 'reward' ? { automation: true, ...(entry.reward || {}) } : {}),
    from: {
      ...(entry.from.walletId ? { id: entry.from.walletId, name: 'Allowance' } : {}),
      ...(entry.from.oid ? { user: entry.from.oid } : {}),
      displayName: entry.from.displayName,
    },
    to: { name: 'Private', user: entry.to.oid, displayName: entry.to.displayName },
  },
});

let defaultStore = null;
const zapRecords = () => {
  if (!defaultStore) defaultStore = createZapRecordStore();
  return defaultStore;
};
const resetZapRecordsForTests = () => {
  defaultStore = null;
};

module.exports = { createZapRecordStore, resetZapRecordsForTests, toPayment, zapRecords };
