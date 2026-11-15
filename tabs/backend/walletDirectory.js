// filepath: tabs/backend/walletDirectory.js
// Everything Zaplie knows about a person's money, on top of peopleStore.js:
//
//   * Allowance wallet - owned by zaplie.service. Created on first sign-in
//     when LNBITS_API_TOKEN is configured (POST /api/v1/wallet creates a
//     wallet under the token's own account), otherwise linked by an operator
//     who pastes the keys of a wallet created in the LNbits UI.
//   * Receive target - where the person's zaps land: a Lightning address
//     (paid over LNURL-pay) or the invoice key of their own Private wallet.
//     Zaplie can create invoices on, and read, that wallet; it can never
//     spend from it.
//
// Nothing here creates LNbits users or mints balance: an opening allowance is
// a payment from the Fund wallet (the allowance extension), never a top-up.
const { lnbitsApiToken, publicLnbitsHost, treasuryInkey } = require('./lnbitsConfig');
const { LnbitsGatewayError, lnbitsRequest } = require('./lnbitsClient');
const { LnurlPayError, fetchPayRequest, requestInvoice } = require('./lnurlPay');
const { normalizeOid, peopleStore: defaultPeopleStore } = require('./peopleStore');

const WALLET_KEY_PATTERN = /^[0-9a-f]{32}$/i;
const MAX_WALLET_NAME = 64;
const MAX_INVOICE_LENGTH = 4096;

const fail = (message, status, { expose = status < 500 } = {}) =>
  new LnbitsGatewayError(message, status, { expose });

const validWalletKey = (value) => typeof value === 'string' && WALLET_KEY_PATTERN.test(value.trim());

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

const createWalletDirectory = ({
  store: storeOption,
  request = lnbitsRequest,
  env = process.env,
  resolvePayRequest = fetchPayRequest,
  requestAddressInvoice = requestInvoice,
} = {}) => {
  const store = () => storeOption || defaultPeopleStore();
  const tokenConfigured = () => Boolean(lnbitsApiToken(env));
  const inFlight = new Map();

  const walletInfo = (walletKey) => request('/api/v1/wallet', { walletKey });

  /** zaplie.service's own wallets, keys included; null without the token. */
  const listServiceWallets = async () => {
    if (!tokenConfigured()) return null;
    const wallets = await request('/api/v1/wallets', { apiToken: true });
    if (!Array.isArray(wallets)) {
      throw fail('LNbits wallets response is malformed', 502);
    }
    return wallets.filter((wallet) => wallet && wallet.deleted !== true);
  };

  const createServiceWallet = async (name) => {
    const wallet = await request('/api/v1/wallet', {
      method: 'POST',
      apiToken: true,
      body: { name },
    });
    if (
      !wallet ||
      typeof wallet.id !== 'string' ||
      !validWalletKey(wallet.adminkey) ||
      !validWalletKey(wallet.inkey)
    ) {
      throw fail('LNbits did not return a complete wallet', 502);
    }
    return wallet;
  };

  /**
   * Makes sure the signed-in person is in the directory and, when the API
   * token allows it, has an Allowance wallet. Concurrent calls for one person
   * share one operation, so two tabs cannot create two wallets.
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
      if (!person.allowance && tokenConfigured()) {
        const wallet = await createServiceWallet(allowanceWalletName(person.displayName));
        person = store().setAllowanceWallet(oid, {
          walletId: wallet.id,
          adminkey: wallet.adminkey,
          inkey: wallet.inkey,
          source: 'token',
        });
        createdWallets.push('Allowance');
      }
      return {
        person,
        created,
        createdWallets,
        // Without the token a new person waits for an operator to link a wallet.
        awaitingOperator: !person.allowance,
      };
    })().finally(() => inFlight.delete(oid));

    inFlight.set(oid, operation);
    return operation;
  };

  /**
   * The operator path: the keys of a wallet created under zaplie.service in
   * the LNbits UI, pasted in the admin portal. Both keys must open the same
   * wallet; with the token, the wallet must also belong to zaplie.service.
   */
  const linkAllowanceWallet = async ({ oid: oidInput, displayName, adminkey, inkey }) => {
    const oid = normalizeOid(oidInput);
    if (!oid) throw fail('invalid Entra object id', 400);
    if (!validWalletKey(adminkey) || !validWalletKey(inkey) || adminkey.trim() === inkey.trim()) {
      throw fail('paste the wallet admin key and invoice key (32 hex characters each)', 400);
    }
    const admin = adminkey.trim();
    const invoice = inkey.trim();
    const adminInfo = await walletInfo(admin);
    if (!adminInfo || typeof adminInfo.id !== 'string' || !adminInfo.id) {
      throw fail('that admin key did not open a wallet', 400);
    }
    const invoiceInfo = await walletInfo(invoice);
    if (
      (invoiceInfo?.id && invoiceInfo.id !== adminInfo.id) ||
      invoiceInfo?.name !== adminInfo.name
    ) {
      throw fail('the admin key and invoice key belong to different wallets', 400);
    }

    let ownershipVerified = false;
    const serviceWallets = await listServiceWallets();
    if (serviceWallets) {
      const owned = serviceWallets.find((wallet) => wallet.id === adminInfo.id);
      if (!owned) {
        throw fail('that wallet is not owned by the Zaplie service account', 400);
      }
      ownershipVerified = true;
    }

    const holder = store().findByAllowanceWalletId(adminInfo.id);
    if (holder && holder.oid !== oid) {
      throw fail('that wallet is already linked to another person', 409);
    }

    store().upsertProfile({ oid, displayName });
    const person = store().setAllowanceWallet(oid, {
      walletId: adminInfo.id,
      adminkey: admin,
      inkey: invoice,
      source: 'operator',
    });
    return { person, ownershipVerified };
  };

  const requirePerson = (oidInput) => {
    const person = store().get(oidInput);
    if (!person) throw fail('No Zaplie wallet is linked to this account', 403);
    return person;
  };

  /**
   * Sets where a person receives. `undefined` keeps a field, `null` or ''
   * clears it. A Lightning address is resolved before it is saved; an invoice
   * key must open a wallet that is not Zaplie's and must not be an admin key.
   */
  const setReceiveTarget = async (oidInput, { lightningAddress, invoiceKey }) => {
    const person = requirePerson(oidInput);
    let nextAddress = person.receive?.lightningAddress || null;
    let nextInkey = person.receive?.inkey || null;

    if (lightningAddress !== undefined) {
      if (lightningAddress === null || lightningAddress === '') {
        nextAddress = null;
      } else {
        let params;
        try {
          params = await resolvePayRequest(lightningAddress, { env });
        } catch (error) {
          if (error instanceof LnurlPayError) throw fail(error.message, error.status);
          throw error;
        }
        if (isAllowancePayLink(params.address, env)) {
          throw fail('that is a Zaplie allowance address, not your own wallet', 400);
        }
        nextAddress = params.address;
      }
    }

    if (invoiceKey !== undefined) {
      if (invoiceKey === null || invoiceKey === '') {
        nextInkey = null;
      } else {
        if (!validWalletKey(invoiceKey)) {
          throw fail('an invoice key is 32 hexadecimal characters', 400);
        }
        const key = invoiceKey.trim();
        if (key === person.allowance?.inkey || key === person.allowance?.adminkey) {
          throw fail('that is your Allowance wallet; register your own Private wallet', 400);
        }
        let info;
        try {
          info = await walletInfo(key);
        } catch (error) {
          if (error.upstreamStatus === 401 || error.upstreamStatus === 403 || error.status === 404) {
            throw fail('that invoice key did not open a wallet', 400);
          }
          throw error;
        }
        // LNbits returns the wallet id (and on newer versions the keys) only
        // to an admin key. Zaplie must never hold a spend key for a Private
        // wallet, so an admin key is refused rather than quietly stored.
        if (info?.id || info?.adminkey) {
          throw fail('that is an admin key; paste the invoice (read) key instead', 400);
        }
        // Every Zaplie wallet a zap could be routed back into. The directory
        // and the Treasury setting are checked first because they do not
        // depend on the token: LNbits masks the keys in GET /api/v1/wallets
        // unless the ACL also grants write on that path, so the listing alone
        // would let any such key through.
        const heldByZaplie =
          key === treasuryInkey(env) ||
          store()
            .list()
            .some((other) => other.allowance?.inkey === key);
        const serviceWallets = heldByZaplie ? null : await listServiceWallets();
        if (heldByZaplie || serviceWallets?.some((wallet) => wallet.inkey === key)) {
          throw fail('that wallet belongs to Zaplie; register your own Private wallet', 400);
        }
        nextInkey = key;
      }
    }

    return store().setReceiveTarget(person.oid, {
      lightningAddress: nextAddress,
      inkey: nextInkey,
    });
  };

  /**
   * An invoice that pays `amountSats` to the person: from their Lightning
   * address when they registered one, else on their Private wallet through
   * its invoice key. `extra` only reaches LNbits on the invoice-key path; the
   * payer attaches it to the outgoing payment either way.
   */
  const createInvoiceFor = async (oidInput, { amountSats, memo, extra }) => {
    const person = store().get(oidInput);
    if (!person) throw fail('Recipient is not registered with Zaplie', 404);
    const name = person.displayName || 'This person';
    if (person.receive?.lightningAddress) {
      try {
        return {
          paymentRequest: await requestAddressInvoice(person.receive.lightningAddress, amountSats, memo, {
            env,
          }),
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
    }
    if (person.receive?.inkey) {
      const result = await request('/api/v1/payments', {
        method: 'POST',
        walletKey: person.receive.inkey,
        body: { out: false, amount: amountSats, memo, ...(extra ? { extra } : {}) },
      });
      const paymentRequest = result?.payment_request || result?.bolt11;
      if (typeof paymentRequest !== 'string' || !paymentRequest || paymentRequest.length > MAX_INVOICE_LENGTH) {
        throw fail('LNbits did not return a complete invoice', 502);
      }
      const invoiceId = [result.checking_id, result.payment_hash].find(
        (value) => typeof value === 'string' && value.length > 0 && value.length <= 256,
      );
      return { paymentRequest, invoiceId, via: 'invoice-key' };
    }
    throw fail(`${name} has not set up where they receive zaps yet`, 409);
  };

  const balanceSats = async (walletKey) => {
    const info = await walletInfo(walletKey);
    const msat = Number(info?.balance);
    return Number.isFinite(msat) ? msat / 1000 : null;
  };

  /** Allowance and (when an invoice key is registered) Private balances. */
  const balancesFor = async (oidInput) => {
    const person = requirePerson(oidInput);
    return {
      allowanceSats: person.allowance?.inkey ? await balanceSats(person.allowance.inkey) : null,
      privateSats: person.receive?.inkey ? await balanceSats(person.receive.inkey) : null,
    };
  };

  return {
    balancesFor,
    createInvoiceFor,
    ensurePerson,
    linkAllowanceWallet,
    listServiceWallets,
    requirePerson,
    setReceiveTarget,
    store,
    tokenConfigured,
  };
};

let defaultDirectory = null;
const walletDirectory = () => {
  if (!defaultDirectory) defaultDirectory = createWalletDirectory();
  return defaultDirectory;
};

module.exports = { allowanceWalletName, createWalletDirectory, walletDirectory };
