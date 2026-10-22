import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DataDirError, resolveDataDir } from './dataDir';
import {
  ensureDataDirectory,
  isErrnoException,
  LedgerFile,
  sweepStaleTemporaries,
  validateDuration,
  withStoreLock,
  writeAtomically,
} from './ledgerFile';

const STORE_VERSION = 1;
const STORE_FILENAME = 'bot-zap-ledger.json';
const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
// A transition that records an already-settled payment can never be safely
// abandoned: giving up leaves the recipient `processing` forever, which no
// retry may clear. It waits far longer than a submit does, and says so
// periodically instead of failing quietly.
const DEFAULT_SETTLE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
// Every write re-serialises the whole store, so an unbounded file eventually
// makes each transition slow enough to queue submits past the lock timeout.
// A `paid` record only has to outlive the card that produced it; ninety days
// is far beyond any adaptive card anyone will still click. `processing` and
// `unknown` are never pruned - they are the ones a human still has to settle.
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
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
  // Lock wait for transitions that record an outcome LNbits has already
  // decided. Separate from lockTimeoutMs on purpose: a submit may fail, a
  // settled payment may not.
  settleLockTimeoutMs?: number;
  // How long a `paid` record is kept. 0 disables pruning entirely.
  retentionMs?: number;
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

// The ledger resolves ZAPLIE_DATA_DIR through the shared resolver so every
// on-disk store agrees: one rule, one place to change it. Resolution
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

const validateStore = (value: unknown, storePath?: string): ZapStore => {
  // A newer schema is the one invalid store an operator can act on, so say
  // which file it is and what wrote it rather than failing generically.
  if (
    isRecord(value) &&
    typeof value.version === 'number' &&
    value.version > STORE_VERSION
  ) {
    throw new ZapLedgerError(
      `Zap ledger ${storePath ?? STORE_FILENAME} was written by a newer ` +
        `version of the bot (store version ${value.version}, this build ` +
        `understands ${STORE_VERSION}); deploy that version or restore a ` +
        'compatible backup - do not delete the file, it records real payments',
    );
  }
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
    return validateStore(JSON.parse(raw) as unknown, storePath);
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

export class ZapLedger {
  readonly storePath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly settleLockTimeoutMs: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly file: LedgerFile;

  constructor(options: ZapLedgerOptions = {}) {
    this.storePath = options.storePath ?? resolveZapLedgerStorePath();
    this.lockPath = `${this.storePath}.lock`;
    const lockRetryMs = validateDuration(
      ZapLedgerError,
      'Zap ledger lock retry duration',
      options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
    );
    this.lockTimeoutMs = validateDuration(
      ZapLedgerError,
      'Zap ledger lock timeout',
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    );
    this.settleLockTimeoutMs = validateDuration(
      ZapLedgerError,
      'Zap ledger settle lock timeout',
      options.settleLockTimeoutMs ?? DEFAULT_SETTLE_LOCK_TIMEOUT_MS,
    );
    this.retentionMs = validateDuration(
      ZapLedgerError,
      'Zap ledger retention window',
      options.retentionMs ?? DEFAULT_RETENTION_MS,
    );
    this.now = options.now ?? Date.now;
    this.file = {
      storePath: this.storePath,
      lockPath: this.lockPath,
      label: 'Zap ledger',
      lockTimeoutImpact: 'every zap submission fails',
      lockRetryMs,
      errorType: ZapLedgerError,
    };
    ensureDataDirectory(this.file);
    // Once per process, outside the lock: a crash temporary is a startup
    // condition, not something to look for on every payment.
    sweepStaleTemporaries(this.storePath, this.timestamp());
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
      // The payment is already settled at LNbits, so this transition waits far
      // longer than a submit: abandoning it would leave the recipient
      // `processing` forever, and no retry may clear that.
    }, this.settleLockTimeoutMs);
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
      // Same reasoning as markPaid: the payment may have settled, so this
      // record is not optional.
    }, this.settleLockTimeoutMs);
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

  private withStoreLock<T>(
    operation: () => Promise<T>,
    timeoutMs = this.lockTimeoutMs,
  ): Promise<T> {
    return withStoreLock(this.file, operation, timeoutMs);
  }
  // Bounded by construction: every write drops `paid` records past the
  // retention window, so the file cannot grow until a transition outlasts the
  // lock timeout. Pruning here rather than on a timer keeps it on the path
  // that already holds the exclusive lock.
  private prune(store: ZapStore): ZapStore {
    if (this.retentionMs === 0) {
      return store;
    }
    const cutoff = this.timestamp() - this.retentionMs;
    for (const [key, entry] of Object.entries(store.records)) {
      // Only `paid`: `processing` and `unknown` are unfinished business and
      // outlive any window until a human settles them.
      if (entry.state === 'paid' && entry.at < cutoff) {
        delete store.records[key];
      }
    }
    return store;
  }

  private async writeStore(store: ZapStore): Promise<void> {
    // Validate our own output too: a bad transition must never replace the last
    // known-good file.
    const canonical = validateStore(this.prune(store), this.storePath);
    await writeAtomically(this.file, `${JSON.stringify(canonical, null, 2)}\n`);
  }
}
