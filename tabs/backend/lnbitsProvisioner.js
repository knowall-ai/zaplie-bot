// filepath: tabs/backend/lnbitsProvisioner.js
// The LNbits provisioner (walletProvisioner.js): creates a person's Allowance
// wallet under the zaplie.service account, its zaplie-<oid> pay link
// (lnurlp) and an NWC connection on it (nwcprovider) with the allowance
// budget, then hands back only the NWC string and the Lightning address.
//
// Credentials:
//   * `token` - a short-lived LNbits ACL token of zaplie.service the admin
//     pasted for this one request (read on /api/v1/wallets, write on
//     /api/v1/wallet). Held in this closure only; never stored or logged.
//     In LNbits 1.7.1 write on /api/v1/wallet also allows resetting keys of,
//     or deleting, any zaplie.service wallet, hence "short-lived".
//   * the new wallet's admin key - returned by LNbits on creation, used for
//     the pay link and the NWC registration, then dropped.
//
// NWC pairing: nwcprovider's pairing endpoint takes the secret in its URL
// path, where proxy access logs would keep it. The pairing URL is fetched
// with a throwaway value instead, and the real secret is put in locally.
const crypto = require('crypto');
const { lnbitsRequest } = require('./lnbitsClient');
const { publicLnbitsHost } = require('./lnbitsConfig');
const { allowanceDescription, allowanceUsername } = require('./payLinkService');
const { WalletGatewayError } = require('./walletErrors');

const NWC_PERMISSIONS = ['pay', 'invoice', 'lookup', 'history', 'balance', 'info'];
const MAX_WALLET_NAME = 64;

/** A fresh NWC client key pair: hex secret and its x-only public key. */
const newNwcKeyPair = () => {
  for (;;) {
    const secret = crypto.randomBytes(32);
    try {
      const ecdh = crypto.createECDH('secp256k1');
      ecdh.setPrivateKey(secret);
      return {
        secret: secret.toString('hex'),
        pubkey: ecdh.getPublicKey('hex', 'compressed').slice(2),
      };
    } catch (_error) {
      // A secret outside the curve order is astronomically rare: draw again.
    }
  }
};

/** `Allowance - <name> (zaplie-<oid prefix>)`: unique per person, so a rerun finds it. */
const allowanceWalletName = ({ oid, displayName }) => {
  const suffix = ` (${allowanceUsername(oid)})`;
  const name = String(displayName || 'Zaplie user').replace(/[\r\n\t]+/g, ' ').trim();
  return `Allowance - ${name}`.slice(0, MAX_WALLET_NAME - suffix.length) + suffix;
};

const withSecret = (pairingUrl, secret) => {
  const match = /^(nostr\+walletconnect:\/\/[0-9a-f]{64}\?)(.*)$/i.exec(String(pairingUrl || '').trim());
  if (!match) throw new WalletGatewayError('LNbits did not return an NWC pairing URL', 502);
  const params = new URLSearchParams(match[2]);
  params.set('secret', secret);
  // Relay URLs stay readable; URLSearchParams would percent-encode them,
  // which every NWC client accepts as well.
  return `${match[1]}${params.toString()}`;
};

const createLnbitsProvisioner = ({ token, request = lnbitsRequest, env = process.env } = {}) => {
  if (typeof token !== 'string' || token.trim().length < 16 || /\s/.test(token.trim())) {
    throw new WalletGatewayError('paste the short-lived LNbits ACL token of zaplie.service', 400, { expose: true });
  }
  const bearer = token.trim();

  const lnbits = async (path, options, step) => {
    try {
      return await request(path, options);
    } catch (error) {
      const status = error.upstreamStatus;
      const why =
        status === 401 || status === 403
          ? 'LNbits refused the token (expired, or missing that permission)'
          : status === 404
            ? 'LNbits does not offer that (is the extension enabled for zaplie.service?)'
            : `LNbits answered ${status || 'nothing'}`;
      throw new WalletGatewayError(`${step}: ${why}`, 502, { expose: true });
    }
  };

  /**
   * Creates the wallet, its pay link and its NWC connection. Refuses, rather
   * than duplicates, when a wallet of the same name already exists (a
   * previous run stopped part-way): that one is finished or deleted by hand.
   */
  const provisionAllowance = async (person, { budgetSats, refreshSeconds }) => {
    const name = allowanceWalletName(person);
    const existing = await lnbits('/api/v1/wallets', { bearer }, 'Listing zaplie.service wallets');
    if (Array.isArray(existing) && existing.some((wallet) => wallet?.name === name && wallet.deleted !== true)) {
      throw new WalletGatewayError(
        `LNbits already has a wallet named "${name}" that is not linked: link it by hand, or delete it and retry`,
        409,
        { expose: true },
      );
    }

    const wallet = await lnbits('/api/v1/wallet', { method: 'POST', bearer, body: { name } }, 'Creating the wallet');
    const adminkey = wallet?.adminkey;
    if (!wallet || typeof wallet.id !== 'string' || typeof adminkey !== 'string') {
      throw new WalletGatewayError('Creating the wallet: LNbits did not return its keys', 502, { expose: true });
    }

    const username = allowanceUsername(person.oid);
    const link = await lnbits(
      '/lnurlp/api/v1/links',
      {
        method: 'POST',
        walletKey: adminkey,
        body: {
          description: allowanceDescription(person.displayName),
          min: 1,
          max: budgetSats,
          comment_chars: 0,
          username,
        },
      },
      'Creating the pay link',
    );
    const lightningAddress = `${link?.username || username}@${publicLnbitsHost(env)}`;

    const { secret, pubkey } = newNwcKeyPair();
    await lnbits(
      `/nwcprovider/api/v1/nwc/${pubkey}`,
      {
        method: 'PUT',
        walletKey: adminkey,
        body: {
          permissions: NWC_PERMISSIONS,
          description: `Zaplie allowance (${String(person.displayName || person.oid).slice(0, 80)})`,
          expires_at: 0,
          budgets: [{ budget_msats: budgetSats * 1000, refresh_window: refreshSeconds, created_at: Math.floor(Date.now() / 1000) }],
        },
      },
      'Creating the NWC connection',
    );
    const throwaway = crypto.randomBytes(32).toString('hex');
    const pairing = await lnbits(`/nwcprovider/api/v1/pairing/${throwaway}`, { walletKey: adminkey }, 'Reading the NWC pairing');

    return { nwcUrl: withSecret(pairing, secret), lightningAddress };
  };

  return { id: 'lnbits', provisionAllowance };
};

module.exports = { allowanceWalletName, createLnbitsProvisioner, newNwcKeyPair, withSecret };
