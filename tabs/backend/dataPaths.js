const fs = require('fs');
const path = require('path');

const getDataDir = () => {
  const configured = process.env.ZAPLIE_DATA_DIR;
  return configured ? path.resolve(configured) : __dirname;
};

// Loaded lazily: tenantContext needs tenantConfig, which needs nothing here,
// but stores require this module very early.
const tenantNow = () => require('./tenantContext').currentTenant();
const homeNow = () => require('./tenantConfig').homeTenant();

// The data directory root has always held the home tenant's data (Zaplie was
// single-tenant). A marker records whose it is, so a deployment whose
// AAD_TENANT_ID changes cannot quietly serve one organisation another's.
const MARKER = 'tenant.json';
let markerChecked = null;
const assertRootBelongsToHome = (root, home) => {
  if (markerChecked === `${root}|${home}`) return;
  const markerPath = path.join(root, MARKER);
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (marker && marker.tid && marker.tid !== home) {
    throw new Error(
      `the data in ${root} belongs to tenant ${marker.tid}, not the home tenant ${home}; move it under tenants/ before changing AAD_TENANT_ID`,
    );
  }
  if (!marker) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPath, JSON.stringify({ tid: home, assignedAt: new Date().toISOString() }, null, 2), {
      mode: 0o600,
    });
  }
  markerChecked = `${root}|${home}`;
};

/**
 * Where an organisation's file lives: the root for the home tenant (where
 * every existing file already is), `tenants/<tid>/` for any other tenant.
 */
const dataPath = (filename) => {
  const root = getDataDir();
  const tid = tenantNow();
  const home = homeNow();
  if (!tid || !home || tid === home) {
    if (home) assertRootBelongsToHome(root, home);
    return path.join(root, filename);
  }
  return path.join(root, 'tenants', tid, filename);
};

/** A file the whole deployment shares (internal secrets, the GitHub App, ...). */
const globalDataPath = (filename) => path.join(getDataDir(), filename);

const resetTenantMarkerForTests = () => {
  markerChecked = null;
};

module.exports = { dataPath, getDataDir, globalDataPath, resetTenantMarkerForTests };
