// filepath: tabs/backend/lnbitsConfig.js
// Where LNbits is and which credentials this backend may use against it.
//
// Least privilege (docs/LNBITS_MIGRATION.adoc): Zaplie never logs in to LNbits
// and never calls the admin Users API (/users/api/v1/*). It holds only
//   * NWC connection strings for the wallets it spends from (each person's
//     Allowance wallet in peopleStore.js, the Treasury in ZAPLIE_TREASURY_NWC),
//   * the Fund wallet's admin key, for the LNbits allowance extension only
//     (allowanceExtensionClient.js), and
// No standing LNbits token: an admin onboarding people with the LNbits
// provisioner pastes a short-lived ACL token into that one request.
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


/**
 * The Treasury wallet's NWC connection string (automation rewards). The
 * portal pays rewards through it on the bot's behalf; it is the only Treasury
 * credential Zaplie holds.
 */
const treasuryNwc = (env = process.env) => trimmed(env.ZAPLIE_TREASURY_NWC) || null;

/** Invoice key the optional rewards store (nostrmarket) is read with. */
const rewardsStoreInkey = (env = process.env) => trimmed(env.ZAPLIE_REWARDS_STORE_INKEY) || null;

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
  lnbitsUrl,
  publicLnbitsHost,
  rewardsStoreInkey,
  treasuryNwc,
};
