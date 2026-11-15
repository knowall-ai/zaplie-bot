// The allowance sync's cache and audit trail, in the portal data directory.
//
// allowance-sync.json is a cache, not the truth: LNbits and the allowance
// extension are, and every run rebuilds from them. It remembers what Zaplie
// last wrote to each person's schedule (to tell a policy change from a hand
// edit) and the last 50 run summaries. allowance-audit.jsonl gets one line per
// change. Neither ever holds a key.
//
// allowance-sync.lock, beside them, holds one run at a time across processes
// (the portal, its timer and the CLI): created with `wx`, it names the holder
// (pid, host, time) and is taken over once it is older than 30 minutes, which
// no healthy run lasts.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { globalDataPath } = require('./dataPaths');
const { ensureSecureDir, writeJsonSecure } = require('./secureJsonStore');

const STATE_FILE = 'allowance-sync.json';
const AUDIT_FILE = 'allowance-audit.jsonl';
const LOCK_FILE = 'allowance-sync.lock';
const LOCK_STALE_MS = 30 * 60 * 1000;
const MAX_RUNS = 50;

const emptyState = () => ({ version: 1, lastRun: null, runs: [], byPerson: {} });

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const createAllowanceSyncStore = ({
  // The allowance sync runs for the home tenant only (docs/MULTI_TENANT.adoc).
  statePath = globalDataPath(STATE_FILE),
  auditPath = globalDataPath(AUDIT_FILE),
  lockPath = path.join(path.dirname(statePath), LOCK_FILE),
  staleMs = LOCK_STALE_MS,
  clock = () => Date.now(),
} = {}) => {
  const read = () => {
    let raw;
    try {
      raw = fs.readFileSync(statePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.byPerson)) {
      throw new Error(`${STATE_FILE} is malformed`);
    }
    return {
      ...emptyState(),
      ...parsed,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  };

  const write = (state) => {
    writeJsonSecure(statePath, {
      ...state,
      runs: (state.runs || []).slice(-MAX_RUNS),
    });
  };

  const appendAudit = (entries) => {
    if (!entries || entries.length === 0) return;
    ensureSecureDir(path.dirname(auditPath));
    const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    fs.appendFileSync(auditPath, lines, { mode: 0o600 });
  };

  // The holder as written, or null when there is no lock. An unreadable
  // holder is aged by the file's mtime.
  const readLock = () => {
    let raw;
    let mtimeMs;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
      mtimeMs = fs.statSync(lockPath).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    let holder = {};
    try {
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed)) holder = parsed;
    } catch (_error) {
      holder = {};
    }
    const at = Date.parse(holder.at);
    return { ...holder, raw, sinceMs: Number.isFinite(at) ? at : mtimeMs };
  };

  const createLock = (holder) => {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(holder), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  };

  const visibleHolder = (holder) => {
    const { token: _token, sinceMs: _sinceMs, raw: _raw, ...visible } = holder || {};
    return visible;
  };

  /**
   * Takes the cross-process lock. Returns { acquired: true, release } or
   * { acquired: false, holder } while another run holds a fresh lock.
   */
  const acquireLock = () => {
    ensureSecureDir(path.dirname(lockPath));
    const token = crypto.randomUUID();
    const holder = {
      pid: process.pid,
      host: os.hostname(),
      at: new Date(clock()).toISOString(),
      token,
    };
    const release = () => {
      try {
        if (readLock()?.token === token) fs.unlinkSync(lockPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    };
    if (createLock(holder)) return { acquired: true, release };

    const current = readLock();
    if (current && clock() - current.sinceMs <= staleMs) {
      return { acquired: false, holder: visibleHolder(current) };
    }
    // Stale: move it aside under a unique name (a rename is atomic), check it
    // is the stale lock just read and not one another process has taken over
    // with meanwhile (put that one back), then try once more.
    const aside = `${lockPath}.stale-${token}`;
    try {
      fs.renameSync(lockPath, aside);
      if (current && fs.readFileSync(aside, 'utf8') !== current.raw) {
        try {
          fs.linkSync(aside, lockPath);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        fs.unlinkSync(aside);
        return { acquired: false, holder: visibleHolder(readLock()) };
      }
      fs.unlinkSync(aside);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (createLock(holder)) return { acquired: true, release };
    return { acquired: false, holder: visibleHolder(readLock()) };
  };

  /** The holder of a fresh lock (pid, host, time), or null: for status pages. */
  const lockHolder = () => {
    const current = readLock();
    return current && clock() - current.sinceMs <= staleMs ? visibleHolder(current) : null;
  };

  return {
    read,
    write,
    appendAudit,
    acquireLock,
    lockHolder,
    readLock,
    statePath,
    auditPath,
    lockPath,
  };
};

module.exports = {
  AUDIT_FILE,
  LOCK_FILE,
  LOCK_STALE_MS,
  MAX_RUNS,
  STATE_FILE,
  createAllowanceSyncStore,
  emptyState,
};
