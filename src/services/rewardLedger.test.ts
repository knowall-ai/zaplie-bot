import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from '@jest/globals';
import {
  resolveRewardLedgerStorePath,
  RewardLedger,
  RewardLedgerError,
  rewardFingerprint,
  rewardKey,
} from './rewardLedger';

const tempDirectories: string[] = [];

const newStorePath = (): string => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'zaplie-reward-ledger-'),
  );
  tempDirectories.push(directory);
  return path.join(directory, 'bot-reward-ledger.json');
};

const KEY = rewardKey('3f1e8d2a-0000-4000-8000-000000000001');
const OTHER_KEY = rewardKey('3f1e8d2a-0000-4000-8000-000000000002');
const FINGERPRINT = rewardFingerprint({
  source: 'github',
  repo: 'octo-org/octo-repo',
  eventType: 'githubPrMerged',
  recipientId: '583231',
});
const OTHER_FINGERPRINT = rewardFingerprint({
  source: 'github',
  repo: 'octo-org/other-repo',
  eventType: 'githubPrMerged',
  recipientId: '583231',
});
const PAID = {
  status: 'paid' as const,
  paymentHash: 'hash-1',
  recipient: 'octocat',
  amountSats: 21,
};
const PENDING = {
  status: 'pending' as const,
  recipient: 'octocat',
  amountSats: 21,
};

const writeRaw = (storePath: string, value: unknown): void => {
  fs.writeFileSync(storePath, JSON.stringify(value));
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('RewardLedger reservations', () => {
  test('reserve on an empty store acquires and persists processing', async () => {
    const storePath = newStorePath();
    const ledger = new RewardLedger({ storePath, now: () => 1_000 });

    await expect(ledger.reserve(KEY, FINGERPRINT)).resolves.toEqual({
      kind: 'acquired',
    });

    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    expect(onDisk).toEqual({
      version: 1,
      records: {
        [KEY]: { state: 'processing', fingerprint: FINGERPRINT, at: 1_000 },
      },
    });
  });

  test('a second reserve replays the processing entry', async () => {
    const ledger = new RewardLedger({ storePath: newStorePath() });
    await ledger.reserve(KEY, FINGERPRINT);

    await expect(ledger.reserve(KEY, FINGERPRINT)).resolves.toMatchObject({
      kind: 'replay',
      entry: { state: 'processing' },
    });
  });

  test('a reserve after markPaid replays the stored response', async () => {
    const ledger = new RewardLedger({ storePath: newStorePath() });
    await ledger.reserve(KEY, FINGERPRINT);
    await ledger.markPaid(KEY, PAID);

    const result = await ledger.reserve(KEY, FINGERPRINT);

    expect(result).toMatchObject({
      kind: 'replay',
      entry: { state: 'paid', response: PAID },
    });
    // Key order is part of the response a replay must reproduce.
    if (result.kind === 'replay' && result.entry.state === 'paid') {
      expect(JSON.stringify(result.entry.response)).toBe(JSON.stringify(PAID));
    }
  });

  test('a reserve after markPending replays the stored response', async () => {
    const ledger = new RewardLedger({ storePath: newStorePath() });
    await ledger.reserve(KEY, FINGERPRINT);
    await ledger.markPending(KEY, PENDING);

    await expect(ledger.reserve(KEY, FINGERPRINT)).resolves.toMatchObject({
      kind: 'replay',
      entry: { state: 'pending', response: PENDING },
    });
  });

  test('a reserve after markUncertain replays uncertain', async () => {
    const ledger = new RewardLedger({ storePath: newStorePath() });
    await ledger.reserve(KEY, FINGERPRINT);
    await ledger.markUncertain(KEY);

    await expect(ledger.reserve(KEY, FINGERPRINT)).resolves.toMatchObject({
      kind: 'replay',
      entry: { state: 'uncertain' },
    });
  });

  test('a reserve with a different fingerprint is a conflict', async () => {
    const ledger = new RewardLedger({ storePath: newStorePath() });
    await ledger.reserve(KEY, FINGERPRINT);
    await ledger.markPaid(KEY, PAID);

    await expect(ledger.reserve(KEY, OTHER_FINGERPRINT)).resolves.toEqual({
      kind: 'conflict',
    });
    await expect(ledger.get(KEY)).resolves.toMatchObject({
      state: 'paid',
      fingerprint: FINGERPRINT,
    });
  });

  test('releaseIfProcessing removes only a processing entry', async () => {
    const ledger = new RewardLedger({ storePath: newStorePath() });
    await ledger.reserve(KEY, FINGERPRINT);
    await ledger.releaseIfProcessing(KEY);
    await expect(ledger.get(KEY)).resolves.toBeUndefined();

    await ledger.reserve(KEY, FINGERPRINT);
    await ledger.markPaid(KEY, PAID);
    await ledger.reserve(OTHER_KEY, FINGERPRINT);
    await ledger.markUncertain(OTHER_KEY);
    await ledger.releaseIfProcessing(KEY);
    await ledger.releaseIfProcessing(OTHER_KEY);

    await expect(ledger.get(KEY)).resolves.toMatchObject({ state: 'paid' });
    await expect(ledger.get(OTHER_KEY)).resolves.toMatchObject({
      state: 'uncertain',
    });
  });

  test('settling transitions refuse an entry that is not processing', async () => {
    const ledger = new RewardLedger({ storePath: newStorePath() });
    await expect(ledger.markPaid(KEY, PAID)).rejects.toThrow(
      'not processing and cannot be marked paid',
    );

    await ledger.reserve(KEY, FINGERPRINT);
    await ledger.markPaid(KEY, PAID);

    await expect(ledger.markPaid(KEY, PAID)).rejects.toThrow(RewardLedgerError);
    await expect(ledger.markPending(KEY, PENDING)).rejects.toThrow(
      'not processing and cannot be marked pending',
    );
    await expect(ledger.markUncertain(KEY)).rejects.toThrow(
      'not processing and cannot be marked uncertain',
    );
    await expect(ledger.get(KEY)).resolves.toMatchObject({ state: 'paid' });
  });

  test('a malformed response is refused before it reaches the store', async () => {
    const ledger = new RewardLedger({ storePath: newStorePath() });
    await ledger.reserve(KEY, FINGERPRINT);

    await expect(
      ledger.markPaid(KEY, { ...PAID, paymentHash: '' }),
    ).rejects.toThrow('Reward ledger paid response is invalid');
    await expect(
      ledger.markPending(KEY, { ...PENDING, amountSats: 0 }),
    ).rejects.toThrow('Reward ledger pending response is invalid');
    await expect(ledger.get(KEY)).resolves.toMatchObject({
      state: 'processing',
    });
  });

  test('a paid entry survives a restart', async () => {
    const storePath = newStorePath();
    const beforeRestart = new RewardLedger({ storePath });
    await beforeRestart.reserve(KEY, FINGERPRINT);
    await beforeRestart.markPaid(KEY, PAID);

    const afterRestart = new RewardLedger({ storePath });

    await expect(afterRestart.reserve(KEY, FINGERPRINT)).resolves.toMatchObject(
      { kind: 'replay', entry: { state: 'paid', response: PAID } },
    );
  });

  test('ten concurrent reserves acquire exactly once', async () => {
    const storePath = newStorePath();
    const ledgers = Array.from(
      { length: 10 },
      () => new RewardLedger({ storePath, lockRetryMs: 1 }),
    );

    const results = await Promise.all(
      ledgers.map(ledger => ledger.reserve(KEY, FINGERPRINT)),
    );

    expect(results.filter(result => result.kind === 'acquired')).toHaveLength(
      1,
    );
    expect(results.filter(result => result.kind === 'replay')).toHaveLength(9);
  });

  test('pruning drops old paid and pending entries and keeps unsettled ones', async () => {
    const storePath = newStorePath();
    let now = 1_000;
    const ledger = new RewardLedger({
      storePath,
      retentionMs: 100,
      now: () => now,
    });
    const keys = ['a', 'b', 'c', 'd'].map(suffix => rewardKey(`old-${suffix}`));
    for (const key of keys) {
      await ledger.reserve(key, FINGERPRINT);
    }
    await ledger.markPaid(keys[0], PAID);
    await ledger.markPending(keys[1], PENDING);
    await ledger.markUncertain(keys[2]);
    // keys[3] stays processing.

    now = 2_000;
    await ledger.reserve(KEY, FINGERPRINT);

    await expect(ledger.get(keys[0])).resolves.toBeUndefined();
    await expect(ledger.get(keys[1])).resolves.toBeUndefined();
    await expect(ledger.get(keys[2])).resolves.toMatchObject({
      state: 'uncertain',
    });
    await expect(ledger.get(keys[3])).resolves.toMatchObject({
      state: 'processing',
    });
  });

  test('a fresh paid entry is kept inside the retention window', async () => {
    let now = 1_000;
    const ledger = new RewardLedger({
      storePath: newStorePath(),
      retentionMs: 100,
      now: () => now,
    });
    await ledger.reserve(KEY, FINGERPRINT);
    await ledger.markPaid(KEY, PAID);

    now = 1_050;
    await ledger.reserve(OTHER_KEY, FINGERPRINT);

    await expect(ledger.get(KEY)).resolves.toMatchObject({ state: 'paid' });
  });
});

describe('RewardLedger store validation', () => {
  test('rejects a store written by a newer version', () => {
    const storePath = newStorePath();
    writeRaw(storePath, { version: 2, records: {} });

    expect(() => new RewardLedger({ storePath })).toThrow(storePath);
    expect(() => new RewardLedger({ storePath })).toThrow(
      'written by a newer version of the bot',
    );
  });

  test.each([
    ['not JSON', 'not json'],
    ['a missing records map', { version: 1 }],
    ['an extra top-level field', { version: 1, records: {}, extra: true }],
    ['a non-hash key', { version: 1, records: { abc: {} } }],
    [
      'an unknown state',
      {
        version: 1,
        records: { [KEY]: { state: 'done', fingerprint: FINGERPRINT, at: 1 } },
      },
    ],
    [
      'a bad fingerprint',
      {
        version: 1,
        records: { [KEY]: { state: 'processing', fingerprint: 'x', at: 1 } },
      },
    ],
    [
      'a negative timestamp',
      {
        version: 1,
        records: {
          [KEY]: { state: 'processing', fingerprint: FINGERPRINT, at: -1 },
        },
      },
    ],
    [
      'a processing entry with a response',
      {
        version: 1,
        records: {
          [KEY]: {
            state: 'processing',
            fingerprint: FINGERPRINT,
            at: 1,
            response: PAID,
          },
        },
      },
    ],
    [
      'a paid entry without a response',
      {
        version: 1,
        records: { [KEY]: { state: 'paid', fingerprint: FINGERPRINT, at: 1 } },
      },
    ],
    [
      'a paid entry with a pending response',
      {
        version: 1,
        records: {
          [KEY]: {
            state: 'paid',
            fingerprint: FINGERPRINT,
            at: 1,
            response: PENDING,
          },
        },
      },
    ],
    [
      'a pending response with an extra field',
      {
        version: 1,
        records: {
          [KEY]: {
            state: 'pending',
            fingerprint: FINGERPRINT,
            at: 1,
            response: { ...PENDING, paymentHash: 'hash-1' },
          },
        },
      },
    ],
  ])('rejects %s at startup', (_label, value) => {
    const storePath = newStorePath();
    if (typeof value === 'string') {
      fs.writeFileSync(storePath, value);
    } else {
      writeRaw(storePath, value);
    }

    expect(() => new RewardLedger({ storePath })).toThrow(RewardLedgerError);
  });

  test('rejects keys and fingerprints that are not hashes', async () => {
    const ledger = new RewardLedger({ storePath: newStorePath() });

    await expect(ledger.reserve('not-a-hash', FINGERPRINT)).rejects.toThrow(
      'Reward ledger key is invalid',
    );
    await expect(ledger.reserve(KEY, 'not-a-hash')).rejects.toThrow(
      'Reward ledger fingerprint is invalid',
    );
    await expect(ledger.get('not-a-hash')).rejects.toThrow(
      'Reward ledger key is invalid',
    );
  });

  test('rejects invalid durations', () => {
    expect(
      () => new RewardLedger({ storePath: newStorePath(), retentionMs: -1 }),
    ).toThrow('Reward ledger retention window is invalid');
  });

  test('the lock timeout names the recovery procedure', async () => {
    const storePath = newStorePath();
    const ledger = new RewardLedger({
      storePath,
      lockRetryMs: 1,
      lockTimeoutMs: 10,
    });
    fs.writeFileSync(`${storePath}.lock`, 'held by a crashed process');

    await expect(ledger.reserve(KEY, FINGERPRINT)).rejects.toThrow(
      'Reward ledger lock timed out; every reward request fails until an ' +
        'operator follows the lock recovery procedure in docs/DEPLOYMENT.adoc',
    );
  });

  test('resolves the store under ZAPLIE_DATA_DIR', () => {
    expect(
      resolveRewardLedgerStorePath({ ZAPLIE_DATA_DIR: '/var/zaplie' }, '/app'),
    ).toBe(path.join('/var/zaplie', 'bot-reward-ledger.json'));
    expect(() => resolveRewardLedgerStorePath({}, '/app')).toThrow(
      RewardLedgerError,
    );
  });
});

describe('rewardKey and rewardFingerprint', () => {
  test('rewardKey is deterministic and separates different keys', () => {
    expect(rewardKey('delivery-1')).toBe(rewardKey('delivery-1'));
    expect(rewardKey('delivery-1')).not.toBe(rewardKey('delivery-2'));
    expect(rewardKey('delivery-1')).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each([
    ['empty', ''],
    ['a newline', 'delivery\n1'],
    ['a NUL', 'delivery\u00001'],
    ['DEL', 'delivery\u007f'],
    ['too long', 'x'.repeat(257)],
  ])('rewardKey rejects %s', (_label, value) => {
    expect(() => rewardKey(value)).toThrow(
      'Reward ledger idempotency key is invalid',
    );
  });

  test('rewardFingerprint changes with any bound field', () => {
    const base = {
      source: 'github',
      repo: 'octo-org/octo-repo',
      eventType: 'githubPrMerged',
      recipientId: '583231',
    };
    const fingerprints = new Set([
      rewardFingerprint(base),
      rewardFingerprint({ ...base, repo: 'octo-org/other' }),
      rewardFingerprint({ ...base, eventType: 'githubIssueClosed' }),
      rewardFingerprint({ ...base, recipientId: '1' }),
      rewardFingerprint({ ...base, source: 'other' }),
    ]);
    expect(fingerprints.size).toBe(5);
    expect(rewardFingerprint(base)).toBe(rewardFingerprint({ ...base }));
  });
});
