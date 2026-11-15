// filepath: tabs/backend/nwcWallet.js
// Nostr Wallet Connect (NIP-47) access to a wallet Zaplie spends from: each
// person's Allowance wallet and the Treasury. Zaplie holds only the NWC
// connection string, never an LNbits key, so the backend behind the
// connection can change (LNbits nwcprovider today) without touching Zaplie.
//
// The connection string carries a secret: it is never logged, never put in an
// error message and never returned by an API. `connectionId` (a hash) is the
// stable, non-reversible handle used everywhere else.
//
// Payment outcomes are classified so callers never guess:
//   * NwcPaymentRefused - the wallet answered with a definite refusal
//     (insufficient balance, budget used up, not permitted, payment failed):
//     nothing was paid, a retry is safe.
//   * NwcPaymentUnknown - no answer, or an answer that does not say: the
//     invoice is looked up once; if that cannot settle it either, the outcome
//     is unknown and must be reconciled, never retried blind.
const crypto = require('crypto');
const { publicLnbitsHost } = require('./lnbitsConfig');

const DEFAULT_TIMEOUT_MS = 20 * 1000;
const PAY_TIMEOUT_MS = 45 * 1000;
const HEX64 = /^[0-9a-f]{64}$/i;
const REQUIRED_METHODS = ['pay_invoice', 'make_invoice', 'get_balance', 'lookup_invoice', 'list_transactions'];
// NIP-47 error codes that prove nothing was paid.
const REFUSAL_CODES = new Set([
  'INSUFFICIENT_BALANCE',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'RESTRICTED',
  'UNAUTHORIZED',
  'NOT_IMPLEMENTED',
  'PAYMENT_FAILED',
]);

class NwcError extends Error {
  // `expose` messages are written here, from codes, never from the wallet's
  // free text, so they are safe to show the person.
  constructor(message, { status = 502, code = 'NWC_ERROR', expose = false } = {}) {
    super(message);
    this.name = 'NwcError';
    this.status = status;
    this.code = code;
    this.expose = expose;
  }
}
class NwcPaymentRefused extends NwcError {
  constructor(message, code) {
    super(message, { status: 409, code, expose: true });
    this.name = 'NwcPaymentRefused';
  }
}
class NwcPaymentUnknown extends NwcError {
  constructor(message) {
    super(message, { status: 503, code: 'OUTCOME_UNKNOWN' });
    this.name = 'NwcPaymentUnknown';
  }
}

const REFUSAL_MESSAGES = {
  INSUFFICIENT_BALANCE: 'The wallet does not have enough sats for this payment.',
  QUOTA_EXCEEDED: 'The wallet budget for this period is used up.',
  RATE_LIMITED: 'The wallet is rate limited; try again shortly.',
  RESTRICTED: 'The wallet connection is not allowed to make this payment.',
  UNAUTHORIZED: 'The wallet connection is no longer authorised.',
  NOT_IMPLEMENTED: 'The wallet does not support this payment.',
  PAYMENT_FAILED: 'The payment failed and nothing was sent.',
};

/** Relay URLs a connection may use: ZAPLIE_NWC_RELAYS, else the LNbits nostrclient relay. */
const allowedRelays = (env = process.env) => {
  const configured = String(env.ZAPLIE_NWC_RELAYS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured.length > 0) return new Set(configured);
  const host = publicLnbitsHost(env);
  return new Set(host ? [`wss://${host}/nostrclient/api/v1/relay`] : []);
};

/**
 * Validates a pasted NWC connection string without connecting.
 * Returns `{ url, walletPubkey, relayUrls, lud16, connectionId }`; throws an
 * exposable 400 that never echoes the string.
 */
const parseNwcUrl = (value, env = process.env) => {
  const url = typeof value === 'string' ? value.trim() : '';
  const bad = (why) => new NwcError(`That is not a usable NWC connection string: ${why}.`, { status: 400, code: 'BAD_NWC', expose: true });
  if (!/^nostr\+walletconnect:\/\//i.test(url)) throw bad('it must start with nostr+walletconnect://');
  let parsed;
  try {
    parsed = new URL(url.replace(/^nostr\+walletconnect:\/\//i, 'http://'));
  } catch (_error) {
    throw bad('it could not be read');
  }
  const walletPubkey = parsed.hostname.toLowerCase();
  const secret = parsed.searchParams.get('secret') || '';
  const relayUrls = parsed.searchParams.getAll('relay').map((relay) => relay.trim());
  if (!HEX64.test(walletPubkey)) throw bad('the wallet public key is missing');
  if (!HEX64.test(secret)) throw bad('the secret is missing');
  if (relayUrls.length === 0) throw bad('it names no relay');
  const allowed = allowedRelays(env);
  for (const relay of relayUrls) {
    if (!/^wss:\/\//i.test(relay)) throw bad('relays must use wss://');
    if (!allowed.has('*') && !allowed.has(relay)) {
      throw new NwcError(
        `That NWC connection uses a relay Zaplie does not accept. Allowed: ${[...allowed].join(', ') || 'none configured'}.`,
        { status: 400, code: 'BAD_NWC', expose: true },
      );
    }
  }
  const lud16 = (parsed.searchParams.get('lud16') || '').trim().toLowerCase() || null;
  const connectionId = `nwc_${crypto.createHash('sha256').update(`${walletPubkey}:${secret.toLowerCase()}`).digest('hex').slice(0, 24)}`;
  return { url, walletPubkey, relayUrls, lud16, connectionId };
};

const sdkClientFactory = (url) => {
  // Loaded lazily: the SDK opens relay sockets, which tests never need.
  // eslint-disable-next-line global-require
  const { NWCClient } = require('@getalby/sdk/nwc');
  return new NWCClient({ nostrWalletConnectUrl: url });
};

const withTimeout = (promise, ms, onTimeout) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const paymentHashOf = (preimage) =>
  typeof preimage === 'string' && HEX64.test(preimage)
    ? crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
    : null;

const msatToSats = (msat) => (Number.isFinite(Number(msat)) ? Math.floor(Number(msat) / 1000) : null);

const isTimeoutOrNetwork = (error) =>
  /timeout|network|publish|connect|closed/i.test(`${error?.name} ${error?.code}`);

/**
 * One wallet behind one NWC connection. `clientFactory` is injectable so
 * tests drive a fake wallet; clients are cached per connection and reused
 * (the SDK's pool reconnects relays on its own).
 */
const createNwcWalletFactory = ({
  clientFactory = sdkClientFactory,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  payTimeoutMs = PAY_TIMEOUT_MS,
} = {}) => {
  const clients = new Map();

  const clientFor = (connection) => {
    let client = clients.get(connection.connectionId);
    if (!client) {
      client = clientFactory(connection.url);
      clients.set(connection.connectionId, client);
    }
    return client;
  };

  const drop = (connection) => {
    const client = clients.get(connection.connectionId);
    clients.delete(connection.connectionId);
    try {
      client?.close?.();
    } catch (_error) {
      // Closing a broken client must not mask the error that led here.
    }
  };

  const call = async (connection, method, run, ms = timeoutMs) => {
    try {
      return await withTimeout(run(clientFor(connection)), ms, () =>
        new NwcError(`NWC ${method} timed out`, { code: 'TIMEOUT' }),
      );
    } catch (error) {
      // A stuck or broken relay connection is rebuilt on the next call.
      if (isTimeoutOrNetwork(error)) drop(connection);
      if (error instanceof NwcError) throw error;
      // The wallet's own text is not shown to people; its code is kept.
      throw new NwcError(`NWC ${method} failed`, { code: error?.code || 'NWC_ERROR' });
    }
  };

  /** A wallet handle for a connection string (validated here). */
  const open = (nwcUrl) => {
    const connection = parseNwcUrl(nwcUrl, env);

    const getInfo = () => call(connection, 'get_info', (client) => client.getInfo());

    const getBalanceSats = async () => {
      const result = await call(connection, 'get_balance', (client) => client.getBalance());
      return msatToSats(result?.balance);
    };

    // LNbits nwcprovider does not implement get_budget; a wallet that
    // advertises it is asked, anything else reads as "not reported".
    const getBudget = async (methods) => {
      if (!Array.isArray(methods) || !methods.includes('get_budget')) return null;
      try {
        const budget = await call(connection, 'get_budget', (client) => client.getBudget());
        if (!budget || !Number.isFinite(budget.total_budget)) return null;
        return {
          totalSats: msatToSats(budget.total_budget),
          usedSats: msatToSats(budget.used_budget),
          renewsAt: Number.isFinite(budget.renews_at) ? budget.renews_at : null,
          renewalPeriod: budget.renewal_period || null,
        };
      } catch (_error) {
        return null;
      }
    };

    const makeInvoice = async ({ amountSats, description }) => {
      const tx = await call(connection, 'make_invoice', (client) =>
        client.makeInvoice({ amount: amountSats * 1000, description: description || '' }),
      );
      if (!tx || typeof tx.invoice !== 'string' || !tx.invoice) {
        throw new NwcError('The wallet did not return an invoice');
      }
      return { paymentRequest: tx.invoice, paymentHash: tx.payment_hash || null };
    };

    const lookupInvoice = (request) =>
      call(connection, 'lookup_invoice', (client) => client.lookupInvoice(request));

    const listTransactions = async ({ limit = 100, offset = 0, from } = {}) => {
      const result = await call(connection, 'list_transactions', (client) =>
        client.listTransactions({ limit, offset, ...(from ? { from } : {}) }),
      );
      return Array.isArray(result?.transactions) ? result.transactions : [];
    };

    /**
     * Pays a BOLT 11 invoice. Resolves `{ paymentHash, feesSats }` when the
     * wallet confirms; throws NwcPaymentRefused (nothing paid) or
     * NwcPaymentUnknown (reconcile by the invoice).
     */
    const payInvoice = async (paymentRequest) => {
      try {
        const result = await withTimeout(
          clientFor(connection).payInvoice({ invoice: paymentRequest }),
          payTimeoutMs,
          () => new NwcError('NWC pay_invoice timed out', { code: 'TIMEOUT' }),
        );
        const paymentHash = paymentHashOf(result?.preimage);
        if (!paymentHash) throw new NwcPaymentUnknown('The wallet confirmed a payment without a preimage');
        return { paymentHash, feesSats: msatToSats(result.fees_paid) || 0 };
      } catch (error) {
        if (error instanceof NwcPaymentUnknown) throw error;
        if (REFUSAL_CODES.has(error?.code)) {
          throw new NwcPaymentRefused(REFUSAL_MESSAGES[error.code], error.code);
        }
        if (isTimeoutOrNetwork(error)) drop(connection);
        // No definite answer: ask the wallet once what became of the invoice.
        let tx = null;
        try {
          tx = await lookupInvoice({ invoice: paymentRequest });
        } catch (_lookupError) {
          tx = null;
        }
        if (tx?.state === 'settled') {
          return { paymentHash: tx.payment_hash || paymentHashOf(tx.preimage), feesSats: msatToSats(tx.fees_paid) || 0 };
        }
        if (tx?.state === 'failed') {
          throw new NwcPaymentRefused(REFUSAL_MESSAGES.PAYMENT_FAILED, 'PAYMENT_FAILED');
        }
        throw new NwcPaymentUnknown('The wallet did not confirm the payment');
      }
    };

    return {
      connectionId: connection.connectionId,
      lud16: connection.lud16,
      getInfo,
      getBalanceSats,
      getBudget,
      makeInvoice,
      lookupInvoice,
      listTransactions,
      payInvoice,
    };
  };

  /**
   * Connects to a pasted string and checks it can do what Zaplie needs:
   * returns `{ connectionId, lud16, balanceSats, methods }`.
   */
  const verify = async (nwcUrl) => {
    const wallet = open(nwcUrl);
    const info = await wallet.getInfo();
    const methods = Array.isArray(info?.methods) ? info.methods : [];
    const missing = REQUIRED_METHODS.filter((method) => !methods.includes(method));
    if (missing.length > 0) {
      throw new NwcError(
        `That NWC connection lacks permissions Zaplie needs: ${missing.join(', ')}. Grant pay, invoice, lookup, history, balance and info.`,
        { status: 400, code: 'BAD_NWC', expose: true },
      );
    }
    const balanceSats = await wallet.getBalanceSats();
    return { connectionId: wallet.connectionId, lud16: wallet.lud16 || info?.lud16 || null, balanceSats, methods };
  };

  const closeAll = () => {
    for (const [id] of clients) drop({ connectionId: id });
  };

  return { open, verify, closeAll };
};

let defaultFactory = null;
const nwcWallets = () => {
  if (!defaultFactory) defaultFactory = createNwcWalletFactory();
  return defaultFactory;
};

/** Tests swap the process-wide factory for one over a fake wallet. */
const setNwcWalletsForTests = (factory) => {
  defaultFactory = factory;
};

module.exports = {
  NwcError,
  NwcPaymentRefused,
  NwcPaymentUnknown,
  REQUIRED_METHODS,
  allowedRelays,
  createNwcWalletFactory,
  nwcWallets,
  parseNwcUrl,
  paymentHashOf,
  setNwcWalletsForTests,
};
