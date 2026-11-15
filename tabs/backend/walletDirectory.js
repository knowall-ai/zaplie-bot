// filepath: tabs/backend/walletDirectory.js
// Everything Zaplie knows about a person's money, on top of peopleStore.js:
//
//   * Allowance wallet - owned by zaplie.service, reached only through an NWC
//     connection (NIP-47) whose budget LNbits enforces. Zaplie keeps the
//     connection string (encrypted) and the wallet's zaplie-<oid> Lightning
//     address, which the allowance extension pays into. No LNbits key.
//       - Manual (any wallet backend): an admin pastes the NWC string and the
//         address in Settings (linkAllowanceWallet). The connection is tried
//         before it is saved.
//       - Provisioned: an admin picks people in Settings and a provisioner
//         (walletProvisioner.js; LNbits today) creates wallet, pay link and
//         NWC connection with a token pasted for that one request
//         (provisionPeople); the result is linked exactly like a manual one.
//     There is no standing LNbits token and nothing happens on sign-in.
//   * Receive target - the Lightning address of the person's own Private
//     wallet. Any Lightning backend works; Zaplie only ever pays into it.
//
// Nothing here creates LNbits users or mints balance: an opening allowance is
// a payment from the Fund wallet (the allowance extension), never a top-up.
const { publicLnbitsHost, treasuryNwc } = require('./lnbitsConfig');
const { WalletGatewayError } = require('./walletErrors');
const {
  LnurlPayError,
  fetchPayRequest,
  parseLightningAddress,
  requestInvoice,
} = require('./lnurlPay');
const { NwcError, nwcWallets: defaultNwcWallets } = require('./nwcWallet');
const { normalizeOid, peopleStore: defaultPeopleStore } = require('./peopleStore');

const fail = (message, status, { expose = status < 500 } = {}) =>
  new WalletGatewayError(message, status, { expose });

// The allowance extension pays each Allowance wallet through a pay link named
// zaplie-<oid prefix> (payLinkService.js). Registering one of those as a
// receive target would route zaps back into an Allowance wallet.
const isAllowancePayLink = (address, env) => {
  const [name, domain] = address.split('@');
  return name.startsWith('zaplie-') && domain === publicLnbitsHost(env);
};

const createWalletDirectory = ({
  store: storeOption,
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

  /**
   * Makes sure the signed-in person is in the directory. Concurrent calls
   * for one person share one operation. Nothing is created in any wallet
   * backend: an admin links or provisions the Allowance wallet.
   */
  const ensurePerson = async ({ oid: oidInput, displayName, email }) => {
    const oid = normalizeOid(oidInput);
    if (!oid) throw fail('invalid caller', 400);
    const active = inFlight.get(oid);
    if (active) return active;

    const operation = (async () => {
      const created = !store().get(oid);
      const person = store().upsertProfile({ oid, displayName, email });
      return {
        person,
        created,
        createdWallets: [],
        // A new person waits for an operator to link their Allowance wallet.
        awaitingOperator: !person.allowance,
      };
    })().finally(() => inFlight.delete(oid));

    inFlight.set(oid, operation);
    return operation;
  };

  /**
   * Links an Allowance wallet: an NWC connection (pay, invoice, lookup,
   * history, balance, info; budget = the allowance cap) and the wallet's own
   * Lightning address, typed by an admin or returned by a provisioner. The
   * connection is tried (get_info, get_balance) and the address resolved
   * before anything is saved.
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

  /**
   * Onboards people with a provisioner built for this one request. Sequential
   * on purpose (a handful of people, and LNbits is not hammered); one
   * person's failure is reported and the rest carry on. Returns one result
   * per person: provisioned, already-linked or failed (with a message safe to
   * show the admin). No credential appears in a result.
   */
  const provisionPeople = async ({ provisioner, people, budgetSats, refreshSeconds }) => {
    const results = [];
    for (const entry of people) {
      const oid = normalizeOid(entry?.oid);
      if (!oid) {
        results.push({ oid: String(entry?.oid || '').slice(0, 64), status: 'failed', message: 'not an Entra object id' });
        continue;
      }
      const current = store().get(oid);
      const displayName = (typeof entry.displayName === 'string' && entry.displayName.trim()) || current?.displayName || null;
      if (current?.allowance) {
        results.push({ oid, displayName, status: 'already-linked', lightningAddress: current.allowance.lightningAddress });
        continue;
      }
      try {
        const made = await provisioner.provisionAllowance({ oid, displayName }, { budgetSats, refreshSeconds });
        const { person } = await linkAllowanceWallet({
          oid,
          displayName,
          nwcUrl: made.nwcUrl,
          lightningAddress: made.lightningAddress,
        });
        results.push({
          oid,
          displayName,
          status: 'provisioned',
          allowanceWalletId: person.allowance.walletId,
          lightningAddress: person.allowance.lightningAddress,
        });
      } catch (error) {
        console.warn('Provisioning failed for one person:', oid, error.expose ? error.message : error.name);
        results.push({
          oid,
          displayName,
          status: 'failed',
          message: error.expose ? error.message : 'provisioning failed; see the backend log',
        });
      }
    }
    return results;
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
    balancesFor,
    createInvoiceFor,
    ensurePerson,
    linkAllowanceWallet,
    provisionPeople,
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

module.exports = { createWalletDirectory, walletDirectory };
