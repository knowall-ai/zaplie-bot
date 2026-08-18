const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');

const STORE_VERSION = 1;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 60_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

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

const validateRecord = (record) => {
  if (
    !record ||
    !HASH_PATTERN.test(record.requestHash || '') ||
    !['pending', 'succeeded', 'failed'].includes(record.state)
  ) {
    throw new ZapIdempotencyError(
      'Zap idempotency data is invalid',
      503,
    );
  }
  if (record.state === 'succeeded') {
    normalizeResult(record.result);
  }
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

const acquireLock = async (lockPath) => {
  const startedAt = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx', 0o600);
      return async () => {
        await handle.close();
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
          await fs.promises.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') {
          continue;
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

const createZapIdempotencyStore = ({
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
        throw new ZapIdempotencyError(
          'Zap idempotency data is invalid',
          503,
        );
      }

      const timestamp = now();
      store.records[scope] = {
        requestHash,
        state: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      writeJsonSecure(storePath, store);
      return { state: 'started' };
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

  return {
    begin,
    complete,
    fail,
    requestDigest,
    scopeDigest,
  };
};

module.exports = {
  ZapIdempotencyError,
  createZapIdempotencyStore,
  requestDigest,
  scopeDigest,
};
