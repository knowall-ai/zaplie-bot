import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DataDirError, resolveDataDir } from './dataDir';

const STORE_VERSION = 1;
const STORE_FILENAME = 'bot-zap-ledger.json';
const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^\S{1,256}$/;
const KEY_PART_MAX_LENGTH = 1_024;

export type ZapEntryState = 'processing' | 'paid' | 'unknown';

export interface ZapEntry {
  state: ZapEntryState;
  paymentHash?: string;
  at: number;
}

interface ZapStore {
  version: typeof STORE_VERSION;
  records: Record<string, ZapEntry>;
}

export interface ZapKeyParts {
  tenantId: string;
  conversationId: string;
  cardId: string;
  recipientId: string;
  action: string;
}

export interface ZapLedgerOptions {
  storePath?: string;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  now?: () => number;
}

export class ZapLedgerError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ZapLedgerError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === 'object' && error !== null && 'code' in error;

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

const requireKeyPart = (name: string, value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > KEY_PART_MAX_LENGTH ||
    hasControlCharacter(value)
  ) {
    throw new ZapLedgerError(`Zap ledger ${name} is invalid`);
  }
  return value;
};

// The digest binds the logical Teams action without writing tenant, activity,
// conversation, or recipient identifiers to disk. JSON encoding avoids the
// delimiter collisions possible with concatenated untrusted identifiers.
export const zapKey = (parts: ZapKeyParts): string => {
  const scope = [
    requireKeyPart('tenant id', parts.tenantId),
    requireKeyPart('conversation id', parts.conversationId),
    requireKeyPart('card id', parts.cardId),
    requireKeyPart('recipient id', parts.recipientId),
    requireKeyPart('action', parts.action),
  ];
  return createHash('sha256')
    .update(`zaplie:bot-zap:v1\u0000${JSON.stringify(scope)}`)
    .digest('hex');
};

// The ledger shares ZAPLIE_DATA_DIR with the weekly allowance guard and must
// resolve it identically: one rule, one place to change it. Resolution
// failures are re-raised as ZapLedgerError so every caller of this module sees
// a single error type.
export const resolveZapLedgerStorePath = (
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): string => {
  try {
    return path.join(
      resolveDataDir(environment, workingDirectory),
      STORE_FILENAME,
    );
  } catch (error) {
    if (error instanceof DataDirError) {
      throw new ZapLedgerError(error.message, error);
    }
    throw error;
  }
};

const validateEntry = (value: unknown): ZapEntry => {
  if (!isRecord(value)) {
    throw new ZapLedgerError('Zap ledger entry is invalid');
  }
  const keys = Object.keys(value).sort();
  const state = value.state;
  const at = value.at;
  if (
    (state !== 'processing' && state !== 'paid' && state !== 'unknown') ||
    typeof at !== 'number' ||
    !Number.isSafeInteger(at) ||
    at < 0
  ) {
    throw new ZapLedgerError('Zap ledger entry is invalid');
  }

  if (state === 'paid') {
    if (
      typeof value.paymentHash !== 'string' ||
      !IDENTIFIER_PATTERN.test(value.paymentHash) ||
      keys.join(',') !== 'at,paymentHash,state'
    ) {
      throw new ZapLedgerError('Zap ledger paid entry is invalid');
    }
    return { state, at, paymentHash: value.paymentHash };
  }

  if (keys.join(',') !== 'at,state') {
    throw new ZapLedgerError('Zap ledger unsettled entry is invalid');
  }
  return { state, at };
};

const validateStore = (value: unknown): ZapStore => {
  if (
    !isRecord(value) ||
    value.version !== STORE_VERSION ||
    !isRecord(value.records) ||
    Object.keys(value).sort().join(',') !== 'records,version'
  ) {
    throw new ZapLedgerError('Zap ledger data is invalid');
  }

  const records: Record<string, ZapEntry> = {};
  for (const [key, entry] of Object.entries(value.records)) {
    if (!HASH_PATTERN.test(key)) {
      throw new ZapLedgerError('Zap ledger key is invalid');
    }
    records[key] = validateEntry(entry);
  }
  return { version: STORE_VERSION, records };
};

const readStore = (storePath: string): ZapStore => {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    return validateStore(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { version: STORE_VERSION, records: {} };
    }
    if (error instanceof ZapLedgerError) {
      throw error;
    }
    throw new ZapLedgerError('Zap ledger data could not be read', error);
  }
};

const validateDuration = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ZapLedgerError(`${name} is invalid`);
  }
  return value;
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

export class ZapLedger {
  readonly storePath: string;
  readonly lockPath: string;
  private readonly lockRetryMs: number;
  private readonly lockTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: ZapLedgerOptions = {}) {
    this.storePath = options.storePath ?? resolveZapLedgerStorePath();
    this.lockPath = `${this.storePath}.lock`;
    this.lockRetryMs = validateDuration(
      'Zap ledger lock retry duration',
      options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
    );
    this.lockTimeoutMs = validateDuration(
      'Zap ledger lock timeout',
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    );
    this.now = options.now ?? Date.now;
    this.ensureDataDirectory();
    // Atomic replacements make an unlocked startup read safe. Validating here
    // keeps a corrupt or unreadable canonical store from producing a healthy
    // bot that discovers the problem only when someone tries to move money.
    readStore(this.storePath);
  }

  async tryAcquire(key: string): Promise<boolean> {
    this.validateKey(key);
    return this.withStoreLock(async () => {
      const store = readStore(this.storePath);
      if (store.records[key]) {
        return false;
      }
      store.records[key] = { state: 'processing', at: this.timestamp() };
      await this.writeStore(store);
      return true;
    });
  }

  async markPaid(key: string, paymentHash: string): Promise<void> {
    this.validateKey(key);
    if (!IDENTIFIER_PATTERN.test(paymentHash)) {
      throw new ZapLedgerError('Zap ledger payment hash is invalid');
    }
    await this.withStoreLock(async () => {
      const store = readStore(this.storePath);
      const existing = store.records[key];
      if (existing?.state === 'paid' && existing.paymentHash === paymentHash) {
        return;
      }
      if (existing?.state !== 'processing') {
        throw new ZapLedgerError(
          'Zap ledger entry is not processing and cannot be marked paid',
        );
      }
      store.records[key] = {
        state: 'paid',
        paymentHash,
        at: this.timestamp(),
      };
      await this.writeStore(store);
    });
  }

  // A payment whose outcome could not be determined must not be retried
  // automatically: it may have settled. Nothing in this store expires — an
  // `unknown` record stays until a human reconciles it against LNbits and
  // edits or removes it deliberately.
  async markUnknown(key: string): Promise<void> {
    this.validateKey(key);
    await this.withStoreLock(async () => {
      const store = readStore(this.storePath);
      const existing = store.records[key];
      if (existing?.state === 'unknown') {
        return;
      }
      if (existing?.state !== 'processing') {
        throw new ZapLedgerError(
          'Zap ledger entry is not processing and cannot be marked unknown',
        );
      }
      store.records[key] = { state: 'unknown', at: this.timestamp() };
      await this.writeStore(store);
    });
  }

  // Only a recipient that definitively never reached the payment call may be
  // released. Paid and uncertain records remain permanent barriers.
  async releaseIfProcessing(key: string): Promise<void> {
    this.validateKey(key);
    await this.withStoreLock(async () => {
      const store = readStore(this.storePath);
      if (store.records[key]?.state !== 'processing') {
        return;
      }
      delete store.records[key];
      await this.writeStore(store);
    });
  }

  // Reads are deliberately lock-free. Every write replaces the store with an
  // atomic same-directory rename, so a reader sees either the previous
  // canonical file or the next one, never a partial write. Taking the
  // exclusive lock here would queue card rendering behind the payment path and
  // pay for a lock file fsync per lookup for no added safety.
  async get(key: string): Promise<ZapEntry | undefined> {
    this.validateKey(key);
    const entry = readStore(this.storePath).records[key];
    return entry ? { ...entry } : undefined;
  }

  // One store read for a whole card instead of one per recipient. Absent keys
  // are simply missing from the result.
  async getMany(keys: string[]): Promise<Map<string, ZapEntry>> {
    for (const key of keys) {
      this.validateKey(key);
    }
    const store = readStore(this.storePath);
    const entries = new Map<string, ZapEntry>();
    for (const key of keys) {
      const entry = store.records[key];
      if (entry) {
        entries.set(key, { ...entry });
      }
    }
    return entries;
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ZapLedgerError('Zap ledger timestamp is invalid');
    }
    return value;
  }

  private validateKey(key: string): void {
    if (!HASH_PATTERN.test(key)) {
      throw new ZapLedgerError('Zap ledger key is invalid');
    }
  }

  private ensureDataDirectory(): void {
    const directory = path.dirname(this.storePath);
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
      throw new ZapLedgerError(
        'Zap ledger data directory is unavailable',
        error,
      );
    }
  }

  private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.lockTimeoutMs;

    for (;;) {
      try {
        const handle = await fs.promises.open(this.lockPath, 'wx', 0o600);
        const ownerToken = randomBytes(32).toString('hex');
        try {
          await handle.writeFile(ownerToken, 'utf8');
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await fs.promises.unlink(this.lockPath).catch(() => undefined);
          throw new ZapLedgerError(
            'Zap ledger lock could not be written',
            error,
          );
        }

        return async () => {
          try {
            await handle.close();
            const currentToken = await fs.promises.readFile(
              this.lockPath,
              'utf8',
            );
            if (currentToken !== ownerToken) {
              throw new ZapLedgerError('Zap ledger lock ownership changed');
            }
            await fs.promises.unlink(this.lockPath);
          } catch (error) {
            if (error instanceof ZapLedgerError) {
              throw error;
            }
            throw new ZapLedgerError(
              'Zap ledger lock could not be released',
              error,
            );
          }
        };
      } catch (error) {
        if (error instanceof ZapLedgerError) {
          throw error;
        }
        if (!isErrnoException(error) || error.code !== 'EEXIST') {
          throw new ZapLedgerError(
            'Zap ledger lock could not be acquired',
            error,
          );
        }
        if (Date.now() >= deadline) {
          throw new ZapLedgerError('Zap ledger lock timed out', error);
        }
        await wait(
          Math.min(this.lockRetryMs, Math.max(0, deadline - Date.now())),
        );
      }
    }
  }

  private async writeStore(store: ZapStore): Promise<void> {
    // Validate our own output too: a bad transition must never replace the last
    // known-good file. A unique same-directory temporary keeps rename atomic.
    const canonical = validateStore(store);
    const tempPath = `${this.storePath}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(tempPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(tempPath, this.storePath);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await fs.promises.unlink(tempPath).catch(() => undefined);
      throw new ZapLedgerError('Zap ledger data could not be persisted', error);
    }
  }
}
