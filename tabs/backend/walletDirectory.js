// filepath: tabs/backend/walletDirectory.js
// Everything Zaplie knows about a person's money, on top of peopleStore.js:
//
//   * Allowance wallet - owned by zaplie.service, reached only through an NWC
//     connection (NIP-47) whose budget LNbits enforces. Zaplie keeps the
//     connection string (encrypted) and the wallet's zaplie-<oid> Lightning
//     address, which the allowance extension pays into. No LNbits key.
//       - Default: an operator creates the wallet, its NWC connection and its
//         pay link in the LNbits UI and pastes the string and the address in
//         Settings (linkAllowanceWallet). The connection is tried before it
//         is saved.
//       - Optional (ZAPLIE_AUTO_PROVISION=true with LNBITS_API_TOKEN): the
//         wallet, pay link and NWC connection are created on first sign-in;
//         the wallet keys are used for those three calls and then dropped.
//   * Receive target - the Lightning address of the person's own Private
//     wallet. Any Lightning backend works; Zaplie only ever pays into it.
//
// Nothing here creates LNbits users or mints balance: an opening allowance is
// a payment from the Fund wallet (the allowance extension), never a top-up.
const crypto = require('crypto');
const { lnbitsApiToken, publicLnbitsHost, treasuryNwc } = require('./lnbitsConfig');
const { LnbitsGatewayError, lnbitsRequest } = require('./lnbitsClient');
const {
  LnurlPayError,
  fetchPayRequest,
  parseLightningAddress,
  requestInvoice,
} = require('./lnurlPay');
const { NwcError, nwcWallets: defaultNwcWallets } = require('./nwcWallet');
const { normalizeOid, peopleStore: defaultPeopleStore } = require('./peopleStore');

const MAX_WALLET_NAME = 64;
const NWC_PERMISSIONS = ['pay', 'invoice', 'lookup', 'history', 'balance', 'info'];
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_ALLOWANCE_CAP_SATS = 100000;

const fail = (message, status, { expose = status < 500 } = {}) =>
  new LnbitsGatewayError(message, status, { expose });

const allowanceWalletName = (displayName) =>
  `Allowance - ${String(displayName || 'Zaplie user').replace(/[\r\n\t]+/g, ' ').trim()}`.slice(
    0,
    MAX_WALLET_NAME,
  );

// The allowance extension pays each Allowance wallet through a pay link named
// zaplie-<oid prefix> (payLinkService.js). Registering one of those as a
// receive target would route zaps back into an Allowance wallet.
const isAllowancePayLink = (address, env) => {
  const [name, domain] = address.split('@');
  return name.startsWith('zaplie-') && domain === publicLnbitsHost(env);
};

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

const autoProvisionEnabled = (env) =>
  String(env.ZAPLIE_AUTO_PROVISION || '').trim().toLowerCase() === 'true' && Boolean(lnbitsApiToken(env));

const createWalletDirectory = ({
  store: storeOption,
  request = lnbitsRequest,
  env = process.env,
  nwc: nwcOption,
  resolvePayRequest = fetchPayRequest,
  requestAddressInvoice = requestInvoice,
} = {}) => {
  const store = () => storeOption || defaultPeopleStore();
  const nwc = () => nwcOption || defaultNwcWallets();
  const inFlight = new Map();
  const methodsByConnection = new Map();

  const resolveAddress = async (address) => {
    try {
      return await resolvePayRequest(address, { env });
    } catch (error) {
      if (error instanceof LnurlPayError) throw fail(error.message, error.status);
      throw error;
    }
  };

  // --- optional automatic provisioning (ZAPLIE_AUTO_PROVISION + token) ----

  // The NWC budget is the allowance cap (ALLOWANCE_MAX_AMOUNT_SATS, the
  // same ceiling allowancePolicy.js enforces). A malformed value falls back
  // to the default rather than creating an unlimited connection.
  const allowanceCapSats = () => {
    const raw = String(env.ALLOWANCE_MAX_AMOUNT_SATS ?? '').trim();
    const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_ALLOWANCE_CAP_SATS;
  };

  // Creates the wallet (token), its zaplie-<oid> pay link and an NWC
  // connection limited to the allowance cap (wallet admin key), then forgets
  // the wallet keys. A failure part-way leaves a wallet an operator can finish
  // by hand; nothing is stored until all three exist.
  const provisionWithToken = async (person) => {
    // Lazy: payLinkService imports the gateway, which imports this module.
    // eslint-disable-next-line global-require
    const { allowanceUsername, allowanceDescription } = require('./payLinkService');
    const wallet = await request('/api/v1/wallet', {
      method: 'POST',
      apiToken: true,
      body: { name: allowanceWalletName(person.displayName) },
    });
    if (!wallet || typeof wallet.id !== 'string' || !wallet.adminkey) {
      throw fail('LNbits did not return a complete wallet', 502);
    }
    const cap = allowanceCapSats();
    const link = await request('/lnurlp/api/v1/links', {
      method: 'POST',
      walletKey: wallet.adminkey,
      body: {
        description: allowanceDescription(person.displayName),
        min: 1,
        max: cap,
        comment_chars: 0,
        username: allowanceUsername(person.oid),
      },
    });
    const lightningAddress = `${link?.username || allowanceUsername(person.oid)}@${publicLnbitsHost(env)}`;
    const { secret, pubkey } = newNwcKeyPair();
    await request(`/nwcprovider/api/v1/nwc/${pubkey}`, {
      method: 'PUT',
      walletKey: wallet.adminkey,
      body: {
        permissions: NWC_PERMISSIONS,
        description: `Zaplie allowance (${String(person.displayName || person.oid).slice(0, 80)})`,
        expires_at: 0,
        budgets: [
          {
            budget_msats: cap * 1000,
            refresh_window: WEEK_SECONDS,
            created_at: Math.floor(Date.now() / 1000),
          },
        ],
      },
    });
    const nwcUrl = await request(`/nwcprovider/api/v1/pairing/${secret}`, { walletKey: wallet.adminkey });
    if (typeof nwcUrl !== 'string') throw fail('LNbits did not return an NWC connection', 502);
    const verified = await nwc().verify(nwcUrl);
    return store().setAllowanceWallet(person.oid, {
      walletId: verified.connectionId,
      nwc: nwcUrl,
      lightningAddress,
      source: 'token',
    });
  };

  /**
   * Makes sure the signed-in person is in the directory and, when automatic
   * provisioning is on, has an Allowance wallet. Concurrent calls for one
   * person share one operation, so two tabs cannot create two wallets.
   */
  const ensurePerson = async ({ oid: oidInput, displayName, email }) => {
    const oid = normalizeOid(oidInput);
    if (!oid) throw fail('invalid caller', 400);
    const active = inFlight.get(oid);
    if (active) return active;

    const operation = (async () => {
      const created = !store().get(oid);
      let person = store().upsertProfile({ oid, displayName, email });
      const createdWallets = [];
      if (!person.allowance && autoProvisionEnabled(env)) {
        person = await provisionWithToken(person);
        createdWallets.push('Allowance');
      }
      return {
        person,
        created,
        createdWallets,
        // A new person waits for an operator to link their Allowance wallet.
        awaitingOperator: !person.allowance,
      };
    })().finally(() => inFlight.delete(oid));

    inFlight.set(oid, operation);
    return operation;
  };

  /**
   * The default path: an operator created the wallet under zaplie.service, an
   * NWC connection on it (pay, invoice, lookup, history, balance, info; budget
   * = the allowance cap) and its zaplie-<oid> pay link in the LNbits UI, and
   * pastes the connection string and the address. The connection is tried
   * (get_info, get_balance) and the address resolved before anything is saved.
   */
  const linkAllowanceWallet = async ({ oid: oidInput, displayName, nwcUrl, lightningAddress }) => {
    const oid = normalizeOid(oidInput);
    if (!oid) throw fail('invalid Entra object id', 400);
    let verified;
    try {
      verified = await nwc().verify(nwcUrl);
    } catch (error) {
      if (error instanceof NwcError) {
        throw fail(error.expose ? error.message : 'Could not reach the wallet over that NWC connection', error.status === 400 ? 400 : 502, {
          expose: true,
        });
      }
      throw error;
    }
    const wanted = (typeof lightningAddress === 'string' && lightningAddress.trim()) || verified.lud16;
    if (!wanted) {
      throw fail("enter the Allowance wallet's Lightning address (its zaplie- pay link)", 400);
    }
    let address;
    try {
      address = parseLightningAddress(wanted, env).address;
    } catch (error) {
      throw fail(error.message, 400);
    }
    await resolveAddress(address);

    for (const other of store().list()) {
      if (other.oid === oid) continue;
      if (other.allowance?.walletId === verified.connectionId) {
        throw fail('that NWC connection is already linked to another person', 409);
      }
      if (other.allowance?.lightningAddress === address || other.receive?.lightningAddress === address) {
        throw fail('that Lightning address already belongs to another person', 409);
      }
    }

    store().upsertProfile({ oid, displayName });
    const person = store().setAllowanceWallet(oid, {
      walletId: verified.connectionId,
      nwc: nwcUrl.trim(),
      lightningAddress: address,
      source: 'operator',
    });
    return { person, balanceSats: verified.balanceSats };
  };

  const requirePerson = (oidInput) => {
    const person = store().get(oidInput);
    if (!person) throw fail('No Zaplie wallet is linked to this account', 403);
    return person;
  };

  /**
   * Sets where a person receives: the Lightning address of their own Private
   * wallet. `undefined` keeps it, `null` or '' clears it. The address is
   * resolved before it is saved; an Allowance address is refused.
   */
  const setReceiveTarget = async (oidInput, { lightningAddress }) => {
    const person = requirePerson(oidInput);
    if (lightningAddress === undefined) return person;
    if (lightningAddress === null || lightningAddress === '') {
      return store().setReceiveTarget(person.oid, { lightningAddress: null });
    }
    const params = await resolveAddress(lightningAddress);
    if (isAllowancePayLink(params.address, env) || store().findByAllowanceAddress(params.address)) {
      throw fail('that is a Zaplie allowance address, not your own wallet', 400);
    }
    return store().setReceiveTarget(person.oid, { lightningAddress: params.address });
  };

  /** An invoice that pays `amountSats` to the person's Lightning address. */
  const createInvoiceFor = async (oidInput, { amountSats, memo }) => {
    const person = store().get(oidInput);
    if (!person) throw fail('Recipient is not registered with Zaplie', 404);
    const name = person.displayName || 'This person';
    if (!person.receive?.lightningAddress) {
      throw fail(`${name} has not set up where they receive zaps yet`, 409);
    }
    try {
      return {
        paymentRequest: await requestAddressInvoice(person.receive.lightningAddress, amountSats, memo, { env }),
        via: 'lightning-address',
      };
    } catch (error) {
      if (error instanceof LnurlPayError) {
        throw fail(`${name}'s Lightning address failed: ${error.message}`, error.status === 409 ? 409 : 502, {
          expose: true,
        });
      }
      throw error;
    }
  };

  /** The NWC wallet behind a person's Allowance wallet, or null. */
  const allowanceWallet = (person) => (person?.allowance?.nwc ? nwc().open(person.allowance.nwc) : null);

  /** The Treasury's NWC wallet (ZAPLIE_TREASURY_NWC). */
  const treasuryWallet = () => {
    const url = treasuryNwc(env);
    if (!url) throw fail('ZAPLIE_TREASURY_NWC must be set', 503);
    return nwc().open(url);
  };

  // get_info once per connection: only a wallet that advertises get_budget
  // is asked for its budget (LNbits nwcprovider enforces one but cannot
  // report it, so it reads as "not reported" rather than a guess).
  const budgetFor = async (wallet) => {
    let methods = methodsByConnection.get(wallet.connectionId);
    if (!methods) {
      methods = (await wallet.getInfo())?.methods || [];
      methodsByConnection.set(wallet.connectionId, methods);
    }
    return wallet.getBudget(methods);
  };

  /** Allowance balance and, when the wallet reports one, its budget. */
  const balancesFor = async (oidInput) => {
    const person = requirePerson(oidInput);
    const wallet = allowanceWallet(person);
    if (!wallet) return { allowanceSats: null, budget: null };
    const [allowanceSats, budget] = await Promise.all([
      wallet.getBalanceSats(),
      budgetFor(wallet).catch(() => null),
    ]);
    return { allowanceSats, budget };
  };

  return {
    allowanceWallet,
    autoProvisionEnabled: () => autoProvisionEnabled(env),
    balancesFor,
    createInvoiceFor,
    ensurePerson,
    linkAllowanceWallet,
    requirePerson,
    setReceiveTarget,
    store,
    treasuryWallet,
  };
};

let defaultDirectory = null;
const walletDirectory = () => {
  if (!defaultDirectory) defaultDirectory = createWalletDirectory();
  return defaultDirectory;
};

module.exports = { allowanceWalletName, createWalletDirectory, newNwcKeyPair, walletDirectory };
