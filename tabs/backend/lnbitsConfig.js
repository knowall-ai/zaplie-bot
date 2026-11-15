// filepath: tabs/backend/lnbitsConfig.js
// Where LNbits is and which credentials this backend may use against it.
//
// Least privilege (docs/LNBITS_MIGRATION.adoc): Zaplie never logs in to LNbits
// and never calls the admin Users API (/users/api/v1/*). It holds only
//   * wallet keys of wallets owned by the zaplie.service account (one
//     Allowance wallet per person, kept in peopleStore.js; the Fund and the
//     Treasury wallet from the environment), and
//   * optionally LNBITS_API_TOKEN, an ACL token of zaplie.service scoped to
//     creating and listing its own wallets and reading its own payments.
const { REQUEST_TIMEOUT_MS } = require('./httpTimeout');

class LnbitsConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LnbitsConfigError';
    // A missing setting is the deployment's fault, not LNbits being down.
    this.status = 503;
  }
}

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The LNbits base URL, without a trailing slash. LNBITS_URL is the current
 * name; LNBITS_NODE_URL is still read so existing app settings keep working.
 */
const lnbitsUrl = (env = process.env) => {
  const raw = trimmed(env.LNBITS_URL) || trimmed(env.LNBITS_NODE_URL);
  if (!raw) {
    throw new LnbitsConfigError('LNBITS_URL must be set');
  }
  return raw.replace(/\/+$/, '');
};

/** The optional zaplie.service ACL token, or null when it is not configured. */
const lnbitsApiToken = (env = process.env) => trimmed(env.LNBITS_API_TOKEN) || null;

/**
 * The Treasury wallet's invoice key (automation rewards), which the portal
 * reads payouts with. Its admin key is the bot's alone
 * (ZAPLIE_TREASURY_ADMINKEY) and is deliberately not read here.
 */
const treasuryInkey = (env = process.env) => trimmed(env.ZAPLIE_TREASURY_INKEY) || null;

/**
 * The host Lightning addresses are served on: LNBITS_PUBLIC_HOST, else the
 * host of the LNbits URL. The allowance extension pays over public HTTPS, so
 * this must be the public name (bank.knowall.ai), not an internal address.
 */
const publicLnbitsHost = (env = process.env) => {
  const configured = trimmed(env.LNBITS_PUBLIC_HOST);
  if (configured) {
    return configured.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  }
  try {
    return new URL(trimmed(env.LNBITS_URL) || trimmed(env.LNBITS_NODE_URL)).host.toLowerCase();
  } catch (_error) {
    return '';
  }
};

module.exports = {
  LnbitsConfigError,
  REQUEST_TIMEOUT_MS,
  lnbitsApiToken,
  lnbitsUrl,
  publicLnbitsHost,
  treasuryInkey,
};
