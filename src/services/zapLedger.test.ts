import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from '@jest/globals';
import {
  resolveZapLedgerStorePath,
  ZapLedger,
  ZapLedgerError,
  zapKey,
} from './zapLedger';

const tempDirectories: string[] = [];

const newStorePath = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-ledger-'));
  tempDirectories.push(directory);
  return path.join(directory, 'ledger.json');
};

const key = (
  recipientId: string,
  overrides: Partial<Parameters<typeof zapKey>[0]> = {},
): string =>
  zapKey({
    tenantId: 'tenant-1',
    conversationId: 'conv-1',
    cardId: 'card-1',
    recipientId,
    action: 'submitZaps',
    ...overrides,
  });

const acquireInChild = (storePath: string, entryKey: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const modulePath = path.resolve(__dirname, 'zapLedger.ts');
    const script = [
      'const { ZapLedger } = require(process.argv[1]);',
      '(async () => {',
      '  const ledger = new ZapLedger({ storePath: process.argv[2] });',
      '  const acquired = await ledger.tryAcquire(process.argv[3]);',
      "  process.stdout.write(acquired ? 'acquired' : 'blocked');",
      '})().catch(error => {',
      '  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));',
      '  process.exitCode = 1;',
      '});',
    ].join('\n');
    const child = spawn(
      process.execPath,
      ['-r', 'ts-node/register', '-e', script, modulePath, storePath, entryKey],
      {
        cwd: process.cwd(),
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Ledger child exited with code ${code}`));
      }
    });
  });

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('ZapLedger durability and concurrency', () => {
  test('only one independent instance acquires a recipient concurrently', async () => {
    const storePath = newStorePath();
    const ledgers = [
      new ZapLedger({ storePath }),
      new ZapLedger({ storePath }),
    ];

    const results = await Promise.all(
      ledgers.map(ledger => ledger.tryAcquire(key('alice'))),
    );

    expect(results.sort()).toEqual([false, true]);
    await expect(ledgers[0].get(key('alice'))).resolves.toMatchObject({
      state: 'processing',
    });
  });

  test('two Node processes coordinate through the exclusive lock', async () => {
    const storePath = newStorePath();

    const results = await Promise.all([
      acquireInChild(storePath, key('alice')),
      acquireInChild(storePath, key('alice')),
    ]);

    expect(results.sort()).toEqual(['acquired', 'blocked']);
  });

  test('a paid entry and its payment hash survive restart', async () => {
    const storePath = newStorePath();
    const beforeRestart = new ZapLedger({ storePath });
    await beforeRestart.tryAcquire(key('alice'));
    await beforeRestart.markPaid(key('alice'), 'hash-alice');

    const afterRestart = new ZapLedger({ storePath });

    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
    });
    await expect(afterRestart.tryAcquire(key('alice'))).resolves.toBe(false);
  });

  test('an old processing entry survives restart and never becomes retryable', async () => {
    const storePath = newStorePath();
    const beforeRestart = new ZapLedger({ storePath, now: () => 1 });
    await beforeRestart.tryAcquire(key('alice'));

    const afterRestart = new ZapLedger({ storePath });

    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'processing',
      at: 1,
    });
    await expect(afterRestart.tryAcquire(key('alice'))).resolves.toBe(false);
  });

  test('an unknown outcome survives restart and never becomes retryable', async () => {
    const storePath = newStorePath();
    const beforeRestart = new ZapLedger({ storePath, now: () => 1 });
    await beforeRestart.tryAcquire(key('alice'));
    await beforeRestart.markUnknown(key('alice'));

    const afterRestart = new ZapLedger({ storePath });

    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'unknown',
      at: 1,
    });
    await expect(afterRestart.tryAcquire(key('alice'))).resolves.toBe(false);
  });

  test('only a processing entry can be released for a safe retry', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({ storePath });
    await ledger.tryAcquire(key('alice'));
    await ledger.releaseIfProcessing(key('alice'));
    await expect(ledger.tryAcquire(key('alice'))).resolves.toBe(true);
    await ledger.markPaid(key('alice'), 'hash-alice');

    await ledger.releaseIfProcessing(key('alice'));

    await expect(ledger.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
    });
  });

  test('reads do not wait on the exclusive write lock', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({
      storePath,
      lockRetryMs: 5,
      lockTimeoutMs: 25,
    });
    await ledger.tryAcquire(key('alice'));
    await ledger.markPaid(key('alice'), 'hash-alice');
    await ledger.tryAcquire(key('bob'));
    // A writer (or a crashed one) holds the lock; readers must not block on it.
    fs.writeFileSync(ledger.lockPath, 'writer-in-progress', { mode: 0o600 });

    await expect(ledger.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
    });

    const entries = await ledger.getMany([
      key('alice'),
      key('bob'),
      key('carol'),
    ]);

    expect(entries.get(key('alice'))).toMatchObject({ state: 'paid' });
    expect(entries.get(key('bob'))).toMatchObject({ state: 'processing' });
    expect(entries.has(key('carol'))).toBe(false);
    await expect(ledger.getMany(['not-a-hash'])).rejects.toThrow(
      'Zap ledger key is invalid',
    );

    fs.unlinkSync(ledger.lockPath);
  });

  test('a crash-left lock times out closed and is never evicted by age', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({
      storePath,
      lockRetryMs: 5,
      lockTimeoutMs: 25,
    });
    fs.writeFileSync(ledger.lockPath, 'crashed-owner', { mode: 0o600 });
    fs.utimesSync(ledger.lockPath, new Date(0), new Date(0));

    await expect(ledger.tryAcquire(key('alice'))).rejects.toThrow(
      'Zap ledger lock timed out',
    );
    expect(fs.existsSync(ledger.lockPath)).toBe(true);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test('a partial crash temporary cannot replace the canonical paid entry', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({ storePath });
    await ledger.tryAcquire(key('alice'));
    await ledger.markPaid(key('alice'), 'hash-alice');
    fs.writeFileSync(`${storePath}.999.crash.tmp`, '{"version":', {
      mode: 0o600,
    });

    const afterRestart = new ZapLedger({ storePath });

    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
    });
  });

  test('invalid payment hashes leave the durable processing barrier intact', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({ storePath });
    await ledger.tryAcquire(key('alice'));

    await expect(ledger.markPaid(key('alice'), '')).rejects.toThrow(
      'Zap ledger payment hash is invalid',
    );

    const afterRestart = new ZapLedger({ storePath });
    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'processing',
    });
    await expect(afterRestart.tryAcquire(key('alice'))).resolves.toBe(false);
  });
});

describe('ZapLedger validation and privacy', () => {
  test('the key binds tenant, conversation, card, recipient, and action', () => {
    const base = key('alice');
    expect(key('alice', { tenantId: 'tenant-2' })).not.toBe(base);
    expect(key('alice', { conversationId: 'conv-2' })).not.toBe(base);
    expect(key('alice', { cardId: 'card-2' })).not.toBe(base);
    expect(key('bob')).not.toBe(base);
    expect(key('alice', { action: 'other-action' })).not.toBe(base);
  });

  test('JSON encoding prevents delimiter-based key collisions', () => {
    const first = key('alice', {
      tenantId: 'tenant|conversation',
      conversationId: 'card',
    });
    const second = key('alice', {
      tenantId: 'tenant',
      conversationId: 'conversation|card',
    });

    expect(first).not.toBe(second);
  });

  test('missing or malformed key components fail closed', () => {
    expect(() =>
      key('alice', { tenantId: undefined as unknown as string }),
    ).toThrow('Zap ledger tenant id is invalid');
    expect(() => key('alice', { cardId: '' })).toThrow(
      'Zap ledger card id is invalid',
    );
    expect(() => key('alice', { action: 'submit\nZaps' })).toThrow(
      'Zap ledger action is invalid',
    );
  });

  test('the store contains hashes and outcome metadata, not raw Teams ids', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({ storePath });
    const entryKey = zapKey({
      tenantId: 'secret-tenant-id',
      conversationId: 'secret-conversation-id',
      cardId: 'secret-card-id',
      recipientId: 'secret-recipient-id',
      action: 'submitZaps',
    });
    await ledger.tryAcquire(entryKey);
    await ledger.markPaid(entryKey, 'hash-alice');

    const raw = fs.readFileSync(storePath, 'utf8');

    expect(raw).toContain(entryKey);
    expect(raw).toContain('hash-alice');
    expect(raw).not.toContain('secret-tenant-id');
    expect(raw).not.toContain('secret-conversation-id');
    expect(raw).not.toContain('secret-card-id');
    expect(raw).not.toContain('secret-recipient-id');
    expect(raw).not.toContain('adminkey');
    expect(raw).not.toContain('inkey');
  });

  test('corrupt JSON fails at startup instead of resetting the ledger', () => {
    const storePath = newStorePath();
    fs.writeFileSync(storePath, '{invalid-json', { mode: 0o600 });

    expect(() => new ZapLedger({ storePath })).toThrow(
      'Zap ledger data could not be read',
    );
    expect(fs.readFileSync(storePath, 'utf8')).toBe('{invalid-json');
  });

  test('unexpected persisted wallet data is rejected', () => {
    const storePath = newStorePath();
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        records: {
          [key('alice')]: {
            state: 'processing',
            at: 1,
            wallet: { adminkey: 'must-not-persist' },
          },
        },
      }),
      { mode: 0o600 },
    );

    expect(() => new ZapLedger({ storePath })).toThrow(
      'Zap ledger unsettled entry is invalid',
    );
  });

  test('production and Azure require an explicit absolute data directory', () => {
    const workingDirectory = path.resolve('working-directory');
    const durableDirectory = path.resolve(workingDirectory, 'durable-data');
    expect(() =>
      resolveZapLedgerStorePath({ NODE_ENV: 'production' }, workingDirectory),
    ).toThrow('ZAPLIE_DATA_DIR is required');
    expect(() =>
      resolveZapLedgerStorePath(
        { WEBSITE_INSTANCE_ID: 'azure-instance' },
        workingDirectory,
      ),
    ).toThrow('ZAPLIE_DATA_DIR is required');
    expect(() =>
      resolveZapLedgerStorePath(
        { NODE_ENV: 'production', ZAPLIE_DATA_DIR: 'relative-data' },
        workingDirectory,
      ),
    ).toThrow('ZAPLIE_DATA_DIR must be an absolute durable path');
    expect(() =>
      resolveZapLedgerStorePath(
        {
          NODE_ENV: 'development',
          WEBSITE_SITE_NAME: 'azure-site',
        },
        workingDirectory,
      ),
    ).toThrow('ZAPLIE_DATA_DIR is required');
    expect(
      resolveZapLedgerStorePath(
        {
          NODE_ENV: 'production',
          ZAPLIE_DATA_DIR: durableDirectory,
        },
        workingDirectory,
      ),
    ).toBe(path.join(durableDirectory, 'bot-zap-ledger.json'));
  });

  test('only explicit development mode receives the ignored local fallback', () => {
    const workingDirectory = path.resolve('working-directory');
    expect(
      resolveZapLedgerStorePath({ NODE_ENV: 'development' }, workingDirectory),
    ).toBe(path.join(workingDirectory, '.zaplie-data', 'bot-zap-ledger.json'));
    expect(() => resolveZapLedgerStorePath({}, workingDirectory)).toThrow(
      ZapLedgerError,
    );
  });
});
