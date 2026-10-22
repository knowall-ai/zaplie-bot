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
const STORE_FILENAME = 'bot-reward-ledger.json';
const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
// Same reasoning as the zap ledger: once LNbits has decided a payment, the
// record of it must not be abandoned because another request held the lock.
const DEFAULT_SETTLE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
// A settled record only has to outlive any redelivery of the webhook that
// produced it. GitHub keeps deliveries for days and a Logic App run can be
// resubmitted for as long as its history is kept (90 days by default), so the
// window matches that. `processing` and `uncertain` are never pruned.
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^\S{1,256}$/;
const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

export type PaidRewardResponse = {
  status: 'paid';
  paymentHash: string;
  recipient: string;
  amountSats: number;
};

export type PendingRewardResponse = {
  status: 'pending';
  recipient: string;
  amountSats: number;
};

// `response` is the exact body the first request returned, so a replay is
// byte-identical to it.
export type RewardEntry =
  | { state: 'processing'; fingerprint: string; at: number }
  | {
      state: 'paid';
      fingerprint: string;
      at: number;
      response: PaidRewardResponse;
    }
  | {
      state: 'pending';
      fingerprint: string;
      at: number;
      response: PendingRewardResponse;
    }
  | { state: 'uncertain'; fingerprint: string; at: number };

export type RewardReservation =
  | { kind: 'acquired' }
  | { kind: 'replay'; entry: RewardEntry }
  | { kind: 'conflict' };

interface RewardStore {
  version: typeof STORE_VERSION;
  records: Record<string, RewardEntry>;
}

export interface RewardFingerprintParts {
  source: string;
  repo: string;
  eventType: string;
  recipientId: string;
}

export interface RewardLedgerOptions {
  storePath?: string;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  settleLockTimeoutMs?: number;
  // How long a `paid` or `pending` record is kept. 0 disables pruning.
  retentionMs?: number;
  now?: () => number;
}

export class RewardLedgerError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RewardLedgerError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

/**
 * Ledger key for a caller's Idempotency-Key: a SHA-256 hex digest.
 *
 * The key is hashed rather than stored: it is an opaque value from outside (a
 * GitHub delivery id today) and the ledger only needs equality.
 *
 * @throws RewardLedgerError for an empty key, one over 256 characters, or one
 *   with control characters
 */
export const rewardKey = (idempotencyKey: string): string => {
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    hasControlCharacter(idempotencyKey)
  ) {
    throw new RewardLedgerError('Reward ledger idempotency key is invalid');
  }
  return createHash('sha256')
    .update(`zaplie:bot-reward:v1\u0000${idempotencyKey}`)
    .digest('hex');
};

/**
 * SHA-256 hex digest of what a key was first used for.
 *
 * A reused key with a different fingerprint is a caller bug, not a
 * redelivery, and must not replay someone else's result. The free-text reason
 * is deliberately left out: it is a label, not part of what is being paid.
 */
export const rewardFingerprint = (parts: RewardFingerprintParts): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        parts.source,
        parts.repo,
        parts.eventType,
        parts.recipientId,
      ]),
    )
    .digest('hex');

/**
 * Path of `bot-reward-ledger.json` under ZAPLIE_DATA_DIR.
 *
 * @throws RewardLedgerError when ZAPLIE_DATA_DIR is missing or not absolute
 *   outside explicit development mode
 */
export const resolveRewardLedgerStorePath = (
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
      throw new RewardLedgerError(error.message, error);
    }
    throw error;
  }
};

const isValidRecipient = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isValidAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const validatePaidResponse = (value: unknown): PaidRewardResponse => {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !==
      'amountSats,paymentHash,recipient,status' ||
    value.status !== 'paid' ||
    typeof value.paymentHash !== 'string' ||
    !IDENTIFIER_PATTERN.test(value.paymentHash) ||
    !isValidRecipient(value.recipient) ||
    !isValidAmount(value.amountSats)
  ) {
    throw new RewardLedgerError('Reward ledger paid response is invalid');
  }
  // Rebuilt in the route's key order so a replay serialises identically.
  return {
    status: 'paid',
    paymentHash: value.paymentHash,
    recipient: value.recipient,
    amountSats: value.amountSats,
  };
};

const validatePendingResponse = (value: unknown): PendingRewardResponse => {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'amountSats,recipient,status' ||
    value.status !== 'pending' ||
    !isValidRecipient(value.recipient) ||
    !isValidAmount(value.amountSats)
  ) {
    throw new RewardLedgerError('Reward ledger pending response is invalid');
  }
  return {
    status: 'pending',
    recipient: value.recipient,
    amountSats: value.amountSats,
  };
};

const validateEntry = (value: unknown): RewardEntry => {
  if (!isRecord(value)) {
    throw new RewardLedgerError('Reward ledger entry is invalid');
  }
  const keys = Object.keys(value).sort().join(',');
  const { state, at, fingerprint } = value;
  if (
    typeof at !== 'number' ||
    !Number.isSafeInteger(at) ||
    at < 0 ||
    typeof fingerprint !== 'string' ||
    !HASH_PATTERN.test(fingerprint)
  ) {
    throw new RewardLedgerError('Reward ledger entry is invalid');
  }

  if (state === 'paid' || state === 'pending') {
    if (keys !== 'at,fingerprint,response,state') {
      throw new RewardLedgerError(`Reward ledger ${state} entry is invalid`);
    }
    return state === 'paid'
      ? {
          state,
          fingerprint,
          at,
          response: validatePaidResponse(value.response),
        }
      : {
          state,
          fingerprint,
          at,
          response: validatePendingResponse(value.response),
        };
  }

  if (state === 'processing' || state === 'uncertain') {
    if (keys !== 'at,fingerprint,state') {
      throw new RewardLedgerError('Reward ledger unsettled entry is invalid');
    }
    return { state, fingerprint, at };
  }

  throw new RewardLedgerError('Reward ledger entry is invalid');
};

const validateStore = (value: unknown, storePath?: string): RewardStore => {
  if (
    isRecord(value) &&
    typeof value.version === 'number' &&
    value.version > STORE_VERSION
  ) {
    throw new RewardLedgerError(
      `Reward ledger ${storePath ?? STORE_FILENAME} was written by a newer ` +
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
    throw new RewardLedgerError('Reward ledger data is invalid');
  }

  const records: Record<string, RewardEntry> = {};
  for (const [key, entry] of Object.entries(value.records)) {
    if (!HASH_PATTERN.test(key)) {
      throw new RewardLedgerError('Reward ledger key is invalid');
    }
    records[key] = validateEntry(entry);
  }
  return { version: STORE_VERSION, records };
};

const readStore = (storePath: string): RewardStore => {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    return validateStore(JSON.parse(raw) as unknown, storePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { version: STORE_VERSION, records: {} };
    }
    if (error instanceof RewardLedgerError) {
      throw error;
    }
    throw new RewardLedgerError('Reward ledger data could not be read', error);
  }
};

const cloneEntry = (entry: RewardEntry): RewardEntry =>
  entry.state === 'paid' || entry.state === 'pending'
    ? ({ ...entry, response: { ...entry.response } } as RewardEntry)
    : { ...entry };

/**
 * Idempotency for POST /api/v1/rewards, keyed by the caller's
 * Idempotency-Key. Same storage contract as the zap ledger (one JSON file
 * under ZAPLIE_DATA_DIR, an exclusive lock file, atomic replacement), with
 * its own schema: a reward replay has to return the original response, and a
 * pending reward is a settled outcome that pays nothing.
 */
export class RewardLedger {
  readonly storePath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly settleLockTimeoutMs: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly file: LedgerFile;

  /**
   * Opens the store, creating its directory if needed.
   *
   * @throws RewardLedgerError when the data directory, options or existing
   *   store are invalid, so the bot fails at startup rather than mid-payment
   */
  constructor(options: RewardLedgerOptions = {}) {
    this.storePath = options.storePath ?? resolveRewardLedgerStorePath();
    this.lockPath = `${this.storePath}.lock`;
    const lockRetryMs = validateDuration(
      RewardLedgerError,
      'Reward ledger lock retry duration',
      options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
    );
    this.lockTimeoutMs = validateDuration(
      RewardLedgerError,
      'Reward ledger lock timeout',
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    );
    this.settleLockTimeoutMs = validateDuration(
      RewardLedgerError,
      'Reward ledger settle lock timeout',
      options.settleLockTimeoutMs ?? DEFAULT_SETTLE_LOCK_TIMEOUT_MS,
    );
    this.retentionMs = validateDuration(
      RewardLedgerError,
      'Reward ledger retention window',
      options.retentionMs ?? DEFAULT_RETENTION_MS,
    );
    this.now = options.now ?? Date.now;
    this.file = {
      storePath: this.storePath,
      lockPath: this.lockPath,
      label: 'Reward ledger',
      lockTimeoutImpact: 'every reward request fails',
      lockRetryMs,
      errorType: RewardLedgerError,
    };
    ensureDataDirectory(this.file);
    sweepStaleTemporaries(this.storePath, this.timestamp());
    // Fail at startup, not on the first payment, if the store is unreadable.
    readStore(this.storePath);
  }

  /**
   * The single check-and-claim. Whoever writes `processing` is the only
   * request allowed to pay; everyone else gets the existing record back.
   *
   * @returns `acquired` for a new key, `replay` with the stored entry for a
   *   repeat, or `conflict` when the key was used for a different fingerprint
   */
  async reserve(key: string, fingerprint: string): Promise<RewardReservation> {
    this.validateKey(key);
    this.validateFingerprint(fingerprint);
    return withStoreLock(
      this.file,
      async () => {
        const store = readStore(this.storePath);
        const existing = store.records[key];
        if (existing) {
          return existing.fingerprint === fingerprint
            ? { kind: 'replay', entry: cloneEntry(existing) }
            : { kind: 'conflict' };
        }
        store.records[key] = {
          state: 'processing',
          fingerprint,
          at: this.timestamp(),
        };
        await this.writeStore(store);
        return { kind: 'acquired' };
      },
      this.lockTimeoutMs,
    );
  }

  /**
   * Records a settled payment and the response a repeat replays.
   *
   * @throws RewardLedgerError unless the entry is `processing`
   */
  async markPaid(key: string, response: PaidRewardResponse): Promise<void> {
    const validated = validatePaidResponse(response);
    await this.settle(key, 'paid', fingerprint => ({
      state: 'paid',
      fingerprint,
      at: this.timestamp(),
      response: validated,
    }));
  }

  /**
   * Records a reward queued for an unlinked recipient and its response.
   *
   * @throws RewardLedgerError unless the entry is `processing`
   */
  async markPending(
    key: string,
    response: PendingRewardResponse,
  ): Promise<void> {
    const validated = validatePendingResponse(response);
    await this.settle(key, 'pending', fingerprint => ({
      state: 'pending',
      fingerprint,
      at: this.timestamp(),
      response: validated,
    }));
  }

  /**
   * The payment or pending-reward call failed in a way that may still have
   * taken effect. Nothing retries it: the record stays until an operator
   * reconciles it and edits or removes it deliberately.
   *
   * @throws RewardLedgerError unless the entry is `processing`
   */
  async markUncertain(key: string): Promise<void> {
    await this.settle(key, 'uncertain', fingerprint => ({
      state: 'uncertain',
      fingerprint,
      at: this.timestamp(),
    }));
  }

  /**
   * Deletes a `processing` entry so the caller's retry can try again. Only a
   * request that definitively never reached the payment call may be released;
   * any other state is left alone.
   */
  async releaseIfProcessing(key: string): Promise<void> {
    this.validateKey(key);
    await withStoreLock(
      this.file,
      async () => {
        const store = readStore(this.storePath);
        if (store.records[key]?.state !== 'processing') {
          return;
        }
        delete store.records[key];
        await this.writeStore(store);
      },
      this.lockTimeoutMs,
    );
  }

  /**
   * Reads one entry without the lock: every write is an atomic rename, so a
   * reader sees the previous file or the next one.
   */
  async get(key: string): Promise<RewardEntry | undefined> {
    this.validateKey(key);
    const entry = readStore(this.storePath).records[key];
    return entry ? cloneEntry(entry) : undefined;
  }

  private async settle(
    key: string,
    target: RewardEntry['state'],
    build: (fingerprint: string) => RewardEntry,
  ): Promise<void> {
    this.validateKey(key);
    await withStoreLock(
      this.file,
      async () => {
        const store = readStore(this.storePath);
        const existing = store.records[key];
        if (existing?.state !== 'processing') {
          throw new RewardLedgerError(
            `Reward ledger entry is not processing and cannot be marked ${target}`,
          );
        }
        store.records[key] = build(existing.fingerprint);
        await this.writeStore(store);
      },
      this.settleLockTimeoutMs,
    );
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RewardLedgerError('Reward ledger timestamp is invalid');
    }
    return value;
  }

  private validateKey(key: string): void {
    if (!HASH_PATTERN.test(key)) {
      throw new RewardLedgerError('Reward ledger key is invalid');
    }
  }

  private validateFingerprint(fingerprint: string): void {
    if (!HASH_PATTERN.test(fingerprint)) {
      throw new RewardLedgerError('Reward ledger fingerprint is invalid');
    }
  }

  // Settled records past the retention window are dropped on every write, so
  // the file stays bounded. `processing` and `uncertain` are unfinished
  // business and are kept until a human settles them.
  private prune(store: RewardStore): RewardStore {
    if (this.retentionMs === 0) {
      return store;
    }
    const cutoff = this.timestamp() - this.retentionMs;
    for (const [key, entry] of Object.entries(store.records)) {
      if (
        (entry.state === 'paid' || entry.state === 'pending') &&
        entry.at < cutoff
      ) {
        delete store.records[key];
      }
    }
    return store;
  }

  private async writeStore(store: RewardStore): Promise<void> {
    const canonical = validateStore(this.prune(store), this.storePath);
    await writeAtomically(this.file, `${JSON.stringify(canonical, null, 2)}\n`);
  }
}
