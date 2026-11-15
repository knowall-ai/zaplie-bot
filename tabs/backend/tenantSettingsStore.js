// filepath: tabs/backend/tenantSettingsStore.js
// An organisation's own Zaplie settings, kept per tenant (tenant-config.json
// under the tenant's data directory, dataPaths.js):
//   * adminsGroupId  - the Entra group holding the Zaplie.Admin app role,
//                      for the Admins section (Entra stays the source of truth;
//                      Zaplie only remembers which group to show);
//   * guestAllowlist - guests or other people this organisation lets in,
//                      added to ZAPLIE_GUEST_ALLOWLIST (memberGate.js format);
//   * provisioner    - default budget and period for "Add people".
const fs = require('fs');
const { dataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWLIST_ENTRY = /^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@,]+@[a-z0-9.-]+\.[a-z]{2,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const PERIODS = new Set(['daily', 'weekly', 'monthly']);
const MAX_ALLOWLIST = 200;

const EMPTY = { adminsGroupId: null, guestAllowlist: [], provisioner: { defaultBudgetSats: 25000, defaultPeriod: 'weekly' } };

class TenantSettingsError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

const filePath = () => dataPath('tenant-config.json');

const readTenantSettings = () => {
  try {
    const stored = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return { ...EMPTY, ...stored, provisioner: { ...EMPTY.provisioner, ...(stored.provisioner || {}) } };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...EMPTY, provisioner: { ...EMPTY.provisioner } };
    throw error;
  }
};

/** Validates and applies a partial update; anything unknown or malformed is a 400. */
const updateTenantSettings = (patch, { by } = {}) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TenantSettingsError('send a settings object');
  const allowed = new Set(['adminsGroupId', 'guestAllowlist', 'provisioner']);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new TenantSettingsError(`unknown setting "${String(key).slice(0, 40)}"`);
  }
  const next = readTenantSettings();
  if (patch.adminsGroupId !== undefined) {
    if (patch.adminsGroupId !== null && !(typeof patch.adminsGroupId === 'string' && GUID.test(patch.adminsGroupId))) {
      throw new TenantSettingsError('the Zaplie Admins group is an Entra object id');
    }
    next.adminsGroupId = patch.adminsGroupId ? patch.adminsGroupId.toLowerCase() : null;
  }
  if (patch.guestAllowlist !== undefined) {
    if (!Array.isArray(patch.guestAllowlist) || patch.guestAllowlist.length > MAX_ALLOWLIST) {
      throw new TenantSettingsError(`the guest allow-list is a list of at most ${MAX_ALLOWLIST} entries`);
    }
    const entries = patch.guestAllowlist.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
    const bad = entries.find((entry) => !ALLOWLIST_ENTRY.test(entry));
    if (bad) throw new TenantSettingsError(`"${bad.slice(0, 80)}" is not person@domain, @domain or an object id`);
    next.guestAllowlist = [...new Set(entries)];
  }
  if (patch.provisioner !== undefined) {
    const { defaultBudgetSats, defaultPeriod } = patch.provisioner || {};
    if (!Number.isSafeInteger(defaultBudgetSats) || defaultBudgetSats <= 0 || !PERIODS.has(defaultPeriod)) {
      throw new TenantSettingsError('the provisioner defaults are a positive budget and daily, weekly or monthly');
    }
    next.provisioner = { defaultBudgetSats, defaultPeriod };
  }
  next.updatedAt = new Date().toISOString();
  if (by) next.updatedBy = by;
  writeJsonSecure(filePath(), next);
  return next;
};

module.exports = { TenantSettingsError, readTenantSettings, updateTenantSettings };
