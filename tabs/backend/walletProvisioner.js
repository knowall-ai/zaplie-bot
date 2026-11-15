// filepath: tabs/backend/walletProvisioner.js
// The wallet PROVISIONER interface: how an admin onboards a person without
// typing an NWC connection by hand. Everything outside a provisioner is
// backend-agnostic: it only ever sees the result, an NWC connection string
// and a Lightning address, and stores them exactly like a manual link.
//
//   provisioner.id                       e.g. 'lnbits'
//   provisioner.provisionAllowance(person, { budgetSats, refreshSeconds })
//     person: { oid, displayName }
//     -> { nwcUrl, lightningAddress }    a new wallet's NWC connection (with
//                                        the budget enforced by the backend)
//                                        and its zaplie-<oid> address
//
// A provisioner is built per admin request from credentials the admin pasted
// for that request; it must not persist or log them, and must not return any
// wallet key it used on the way.
const { createLnbitsProvisioner } = require('./lnbitsProvisioner');
const { WalletGatewayError } = require('./walletErrors');

const PROVISIONERS = {
  lnbits: ({ token, env }) => createLnbitsProvisioner({ token, env }),
};

const PERIOD_SECONDS = { daily: 86400, weekly: 7 * 86400, monthly: 30 * 86400 };

/** The provisioners an admin may pick, for the UI. */
const availableProvisioners = () => Object.keys(PROVISIONERS);

/** Builds a provisioner for one request; throws a 400 for an unknown kind. */
const createProvisioner = (kind, options, registry = PROVISIONERS) => {
  const make = registry[kind];
  if (!make) throw new WalletGatewayError(`unknown provisioner "${String(kind).slice(0, 40)}"`, 400, { expose: true });
  return make(options);
};

module.exports = { PERIOD_SECONDS, availableProvisioners, createProvisioner };
