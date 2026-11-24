const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');

const STORE_VERSION = 1;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 60_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_TTL_DAYS = 30;
const IDENTIFIER_PATTERN = /^[\x20-\x7e]{1,256}$/;

// Settled records only have to outlive the window in which a client could still
// retry. Keeping them forever grows a file that is rewritten in full under the
// lock on every single zap, so the sweep is what keeps zaps O(active) instead
// of O(all zaps ever).
const ttlMs = () => {
  const configured = process.env.ZAP_IDEMPOTENCY_TTL_DAYS;
  if (configured === undefined || configured === '') {
    return DEFAULT_TTL_DAYS * 86_400_000;
  }
  const days = Number(configured);
  if (!Number.isFinite(days) || days <= 0) {
    throw new ZapIdempotencyError(
      'ZAP_IDEMPOTENCY_TTL_DAYS must be a positive number of days',
      503,
    );
  }
  return days * 86_400_000;
};

class ZapIdempotencyError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = 'ZapIdempotencyError';
    this.status = status;
  }
}

const digest = (value) =>
  createHash('sha256').update(String(value)).digest('hex');

const requestDigest = ({ recipientUserId, amount, memo }) =>
  digest(JSON.stringify([recipientUserId, amount, memo]));

const scopeDigest = ({ aadObjectId, idempotencyKey }) =>
  digest(`${aadObjectId}\u0000${idempotencyKey}`);

const normalizeResult = (result) => {
  const validIdentifier = (value) =>
    typeof value === 'string' && value.length > 0 && value.length <= 256;
  if (
    !result ||
    !validIdentifier(result.payment_hash) ||
    !validIdentifier(result.checking_id)
  ) {
    throw new ZapIdempotencyError(
      'Zap idempotency result is invalid',
      503,
    );
  }
  return {
    payment_hash: result.payment_hash,
    checking_id: result.checking_id,
  };
};

// Identifiers are recorded before the payment leaves, so a zap whose outcome is
// unknown can still be reconciled against LNbits by invoice id.
const normalizePayment = (payment) => {
  if (payment === undefined) {
    return undefined;
  }
  const valid = (value) =>
    value === undefined ||
    (typeof value === 'string' && IDENTIFIER_PATTERN.test(value));
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)) {
    throw new ZapIdempotencyError('Zap idempotency data is invalid', 503);
  }
  const validRequest =
    payment.paymentRequest === undefined ||
    (typeof payment.paymentRequest === 'string' &&
      /^[\x21-\x7e]{1,4096}$/.test(payment.paymentRequest));
  if (!valid(payment.invoiceId) || !valid(payment.paymentHash) || !validRequest) {
    throw new ZapIdempotencyError('Zap idempotency data is invalid', 503);
  }
  const normalized = {};
  if (payment.invoiceId !== undefined) normalized.invoiceId = payment.invoiceId;
  if (payment.paymentHash !== undefined) {
    normalized.paymentHash = payment.paymentHash;
  }
  // The full invoice: invoiceId may be only a 256-character fragment, which
  // lookup_invoice cannot use to settle a failed or pending key.
  if (payment.paymentRequest !== undefined) {
    normalized.paymentRequest = payment.paymentRequest;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const validateRecord = (record) => {
  if (
    !record ||
    !HASH_PATTERN.test(record.requestHash || '') ||
    !['pending', 'succeeded', 'failed', 'outcome_unknown'].includes(record.state)
  ) {
    throw new ZapIdempotencyError(
      'Zap idempotency data is invalid',
      503,
    );
  }
  if (record.state === 'succeeded') {
    normalizeResult(record.result);
  }
  normalizePayment(record.payment);
};

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const validateStore = (store) => {
  if (
    !store ||
    store.version !== STORE_VERSION ||
    !store.records ||
    typeof store.records !== 'object' ||
    Array.isArray(store.records)
  ) {
    throw new ZapIdempotencyError(
      'Zap idempotency data is invalid',
      503,
    );
  }
  return store;
};

const readStore = (storePath) => {
  try {
    return validateStore(JSON.parse(fs.readFileSync(storePath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { version: STORE_VERSION, records: {} };
    }
    if (error instanceof ZapIdempotencyError) {
      throw error;
    }
    throw new ZapIdempotencyError(
      'Zap idempotency data could not be read',
      503,
    );
  }
};

// A plain unlink lets two waiters that both judged the same lock stale delete it
// twice: the second unlink removes whatever lock exists by then, which can be a
// live one, and two payers proceed. Renaming is atomic per inode, so only one
// waiter can move a given lock out of the way; everyone else loses the rename.
// The inode is re-checked on both sides because the previous holder could have
// released and a new one acquired between the stat and the rename.
const breakStaleLock = async (lockPath, observed) => {
  const graveyard = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  let current;
  try {
    current = await fs.promises.stat(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw new ZapIdempotencyError(
      'Zap idempotency lock could not be inspected',
      503,
    );
  }
  if (current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs) {
    // Somebody else already broke it, or a live holder replaced it.
    return;
  }

  try {
    await fs.promises.rename(lockPath, graveyard);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw new ZapIdempotencyError(
      'Zap idempotency lock could not be broken',
      503,
    );
  }

  let moved;
  try {
    moved = await fs.promises.stat(graveyard);
  } catch {
    return;
  }
  if (moved.ino !== observed.ino) {
    // The path was re-created in the gap and we moved a live lock. Put it back
    // with link(), which refuses to clobber a lock taken in the meantime.
    try {
      await fs.promises.link(graveyard, lockPath);
    } catch {
      // A newer holder owns the path, so the file now sitting in the graveyard
      // is somebody's live lock and not ours to delete: unlinking it would
      // destroy a lock its holder still believes it holds. Leave the file
      // behind instead. It is inert — release() checks the inode before
      // unlinking, so a stranded lock file frees nothing and blocks nobody.
      return;
    }
  }
  try {
    await fs.promises.unlink(graveyard);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new ZapIdempotencyError(
        'Zap idempotency lock could not be broken',
        503,
      );
    }
  }
};

const acquireLock = async (lockPath) => {
  const startedAt = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx', 0o600);
      // Captured while the handle is still open: this is the identity of the
      // lock we actually took, as opposed to whatever sits at the path later.
      const held = await handle.stat();
      return async () => {
        await handle.close();
        // A holder that stalled past STALE_LOCK_MS has had its lock broken and
        // the path handed to somebody else. Unlinking by path would then delete
        // the new holder's lock and let a third process straight in, so release
        // removes the lock only if it is still the one this holder took.
        let current;
        try {
          current = await fs.promises.stat(lockPath);
        } catch (error) {
          if (error.code === 'ENOENT') {
            return;
          }
          throw error;
        }
        if (current.ino !== held.ino || current.mtimeMs !== held.mtimeMs) {
          return;
        }
        try {
          await fs.promises.unlink(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new ZapIdempotencyError(
          'Zap idempotency lock could not be acquired',
          503,
        );
      }

      try {
        const lock = await fs.promises.stat(lockPath);
        if (Date.now() - lock.mtimeMs > STALE_LOCK_MS) {
          await breakStaleLock(lockPath, lock);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') {
          continue;
        }
        if (statError instanceof ZapIdempotencyError) {
          throw statError;
        }
        throw new ZapIdempotencyError(
          'Zap idempotency lock could not be inspected',
          503,
        );
      }
      await wait(LOCK_RETRY_MS);
    }
  }

  throw new ZapIdempotencyError(
    'Zap idempotency lock timed out',
    503,
  );
};

// Swept inside begin(), under the same lock that already rewrites the file, so
// no extra lock round-trip.
//
// Only `succeeded` is ever swept. Everything else is a key that must keep
// refusing: a `failed` key was poisoned after a payment attempt, so letting it
// age out would let a long-delayed retry pay for real, and `pending`,
// `outcome_unknown` or an unrecognised state may still have money in flight.
// Successes are the overwhelming majority, so this still bounds the file.
const pruneExpired = (store, nowMs) => {
  const cutoff = nowMs - ttlMs();
  let pruned = 0;
  for (const [scope, record] of Object.entries(store.records)) {
    if (record?.state !== 'succeeded') {
      continue;
    }
    const settledAt = Date.parse(record?.updatedAt ?? '');
    if (Number.isFinite(settledAt) && settledAt < cutoff) {
      delete store.records[scope];
      pruned += 1;
    }
  }
  return pruned;
};

const createZapIdempotencyStore = ({
  // The file keeps its original name so existing records stay in force.
  storePath = dataPath('lnbits-zap-idempotency.json'),
  now = () => new Date().toISOString(),
} = {}) => {
  const lockPath = `${storePath}.lock`;

  const withStoreLock = async (operation) => {
    const release = await acquireLock(lockPath);
    try {
      return await operation();
    } finally {
      await release();
    }
  };

  const begin = async ({ scope, requestHash }) =>
    withStoreLock(async () => {
      if (!HASH_PATTERN.test(scope) || !HASH_PATTERN.test(requestHash)) {
        throw new ZapIdempotencyError(
          'Zap idempotency request is invalid',
          503,
        );
      }
      const store = readStore(storePath);
      const existing = store.records[scope];
      if (existing) {
        validateRecord(existing);
        if (existing.requestHash !== requestHash) {
          throw new ZapIdempotencyError(
            'Idempotency key was already used for another zap',
          );
        }
        if (existing.state === 'succeeded') {
          return { state: 'replay', result: existing.result };
        }
        if (existing.state === 'pending') {
          return { state: 'pending' };
        }
        if (existing.state === 'failed') {
          return { state: 'failed' };
        }
        if (existing.state === 'outcome_unknown') {
          return { state: 'outcome_unknown', payment: existing.payment };
        }
        throw new ZapIdempotencyError(
          'Zap idempotency data is invalid',
          503,
        );
      }

      const timestamp = now();
      pruneExpired(store, Date.parse(timestamp) || Date.now());
      store.records[scope] = {
        requestHash,
        state: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      writeJsonSecure(storePath, store);
      return { state: 'started' };
    });

  // Called after the invoice exists but before the payment is sent, so a zap
  // that times out mid-payment leaves behind the invoice id needed to ask
  // LNbits what actually happened.
  const attachPayment = async ({ scope, requestHash, invoiceId, paymentHash, paymentRequest }) =>
    withStoreLock(async () => {
      const store = readStore(storePath);
      const existing = store.records[scope];
      if (!existing || existing.requestHash !== requestHash) {
        throw new ZapIdempotencyError(
          'Zap idempotency record does not match the request',
          503,
        );
      }
      validateRecord(existing);
      if (existing.state !== 'pending') {
        throw new ZapIdempotencyError(
          'Zap idempotency record is not pending',
          503,
        );
      }
      existing.payment = normalizePayment({
        ...(existing.payment ?? {}),
        ...(invoiceId === undefined ? {} : { invoiceId }),
        ...(paymentHash === undefined ? {} : { paymentHash }),
        ...(paymentRequest === undefined ? {} : { paymentRequest }),
      });
      existing.updatedAt = now();
      writeJsonSecure(storePath, store);
    });

  // The money has already moved but the success could not be recorded. Failing
  // the key would invite a second payment and leaving it pending would wedge
  // every retry on "already in progress", so the record says outright that the
  // outcome is unknown and keeps the identifiers needed to reconcile it.
  const markOutcomeUnknown = async ({ scope, requestHash, result }) =>
    withStoreLock(async () => {
      const store = readStore(storePath);
      const existing = store.records[scope];
      if (!existing || existing.requestHash !== requestHash) {
        throw new ZapIdempotencyError(
          'Zap idempotency record does not match the request',
          503,
        );
      }
      validateRecord(existing);
      existing.state = 'outcome_unknown';
      existing.payment = normalizePayment({
        ...(existing.payment ?? {}),
        ...(result?.payment_hash === undefined
          ? {}
          : { paymentHash: result.payment_hash }),
      });
      existing.updatedAt = now();
      writeJsonSecure(storePath, store);
    });

  const complete = async ({ scope, requestHash, result }) =>
    withStoreLock(async () => {
      const store = readStore(storePath);
      const existing = store.records[scope];
      if (!existing || existing.requestHash !== requestHash) {
        throw new ZapIdempotencyError(
          'Zap idempotency record does not match the request',
          503,
        );
      }
      validateRecord(existing);
      if (existing.state !== 'pending') {
        throw new ZapIdempotencyError(
          'Zap idempotency record is not pending',
          503,
        );
      }
      existing.state = 'succeeded';
      existing.result = normalizeResult(result);
      existing.updatedAt = now();
      writeJsonSecure(storePath, store);
    });

  const fail = async ({ scope, requestHash }) =>
    withStoreLock(async () => {
      const store = readStore(storePath);
      const existing = store.records[scope];
      if (!existing || existing.requestHash !== requestHash) {
        return;
      }
      validateRecord(existing);
      if (existing.state === 'pending') {
        existing.state = 'failed';
        existing.updatedAt = now();
        writeJsonSecure(storePath, store);
      }
    });

  const release = async ({ scope, requestHash }) =>
    withStoreLock(async () => {
      const store = readStore(storePath);
      const existing = store.records[scope];
      if (!existing || existing.requestHash !== requestHash) {
        return;
      }
      validateRecord(existing);
      if (existing.state === 'pending') {
        delete store.records[scope];
        writeJsonSecure(storePath, store);
      }
    });

  return {
    attachPayment,
    begin,
    complete,
    fail,
    markOutcomeUnknown,
    release,
    requestDigest,
    scopeDigest,
  };
};

module.exports = {
  ZapIdempotencyError,
  createZapIdempotencyStore,
  requestDigest,
  scopeDigest,
  // The stale-lock break decides whether two processes can pay the same zap,
  // and the dangerous interleavings cannot be produced through the public API,
  // so it is reachable for tests.
  __testing: { breakStaleLock },
};
