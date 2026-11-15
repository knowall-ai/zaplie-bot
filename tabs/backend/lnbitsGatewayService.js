// The portal's server-side view of the wallets. People come from Zaplie's own
// directory (walletDirectory.js / peopleStore.js). Every wallet Zaplie spends
// from (each Allowance wallet, the Treasury) is reached over NWC
// (nwcWallet.js); recipients are paid at their Lightning address. Zaplie's
// own record of each payment (zapRecordStore.js) is what the feed, the
// leaderboards and the reports read (docs/LNBITS_MIGRATION.adoc).
const { rewardsStoreInkey } = require('./lnbitsConfig');
const {
  LnbitsGatewayError,
  lnbitsRequest,
  maskKeys,
  redactSensitive,
} = require('./lnbitsClient');
const { positiveIntFromEnv } = require('./rewardAmounts');
const { createZapIdempotencyStore } = require('./lnbitsZapIdempotencyStore');
const { walletDirectory } = require('./walletDirectory');
const { normalizeOid } = require('./peopleStore');
const { NwcPaymentRefused, NwcPaymentUnknown } = require('./nwcWallet');
const { toPayment, zapRecords } = require('./zapRecordStore');

const BALANCE_CACHE_MS = 30 * 1000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;
const MAX_CONCURRENT_READS = 8;
// The name every Allowance wallet is reported under, whatever it is called in
// LNbits: the feed and the bot recognise wallets by this name.
const ALLOWANCE_WALLET_NAME = 'Allowance';

const balanceCache = new Map();

// Zaps and self-issued invoices have their own ceiling. REWARDS_MAX_AMOUNT_SATS
// is documented as the automated-reward cap (default 10000); reading it as the
// zap cap too meant one variable meant two different things.
//
// Precedence: ZAP_MAX_AMOUNT_SATS, else whatever REWARDS_MAX_AMOUNT_SATS is set
// to, else 1,000,000. The middle step is what stops the separation from being a
// silent loosening: env/.env.dev.example ships REWARDS_MAX_AMOUNT_SATS=10000,
// which caps zaps today, so such a deployment keeps its 10,000-sat ceiling until
// an operator names a different one.
//
// Both are read through the reward parser, so a malformed value fails closed as
// a 503 rather than falling back and widening the cap the operator was trying to
// tighten.
const DEFAULT_ZAP_MAX_AMOUNT_SATS = 1_000_000;

const maxZapAmountSats = () => {
  try {
    return (
      positiveIntFromEnv('ZAP_MAX_AMOUNT_SATS', null) ??
      positiveIntFromEnv('REWARDS_MAX_AMOUNT_SATS', null) ??
      DEFAULT_ZAP_MAX_AMOUNT_SATS
    );
  } catch (error) {
    throw new LnbitsGatewayError(error.message, 503);
  }
};

const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/** The User shape the portal renders. No wallet, key or balance. */
const sanitizeUser = (person) => ({
  id: person.oid,
  displayName: String(person.displayName || person.oid),
  profileImg: '',
  aadObjectId: person.oid,
  email: person.email || '',
  type: 'Teammate',
  privateWallet: null,
  allowanceWallet: null,
});

// `Number(wallet.balance_msat || 0)` fabricated a balance: a missing, null or
// unparseable value arrived at the browser as a real-looking 0, which then
// satisfied every client-side `Number.isFinite` guard and rendered as a
// confident "0 sats". Anything that is not a finite number (or a numeric
// string, which LNbits does sometimes send) is passed through as null instead,
// so the consumers can say "Unavailable" rather than invent a zero.
const sanitizeBalanceMsat = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const sanitizeWallet = (wallet) => ({
  id: wallet.id,
  name: wallet.name,
  user: wallet.user,
  balance_msat: sanitizeBalanceMsat(wallet.balance_msat),
  deleted: wallet.deleted === true,
});

const validPaymentId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

const requirePaymentId = (payment) => {
  const paymentId = [payment.checking_id, payment.payment_hash, payment.id].find(
    validPaymentId,
  );
  if (!paymentId) {
    throw new LnbitsGatewayError(
      'LNbits payment response is missing a stable identifier',
    );
  }
  return paymentId;
};

const sanitizePayment = (payment) => {
  const paymentId = requirePaymentId(payment);
  return {
    checking_id: paymentId,
    payment_hash: validPaymentId(payment.payment_hash)
      ? payment.payment_hash
      : undefined,
    // LNbits v1 dropped the boolean `pending` field in favour of `status`;
    // derive it so in-flight payments are not misread as settled.
    pending:
      payment.pending === true ||
      String(payment.status || '').toLowerCase() === 'pending',
    amount: Number(payment.amount || 0),
    fee: Number(payment.fee || 0),
    memo: payment.memo || '',
    time: payment.time,
    extra: redactSensitive(payment.extra || {}),
    wallet_id: payment.wallet_id,
  };
};

// Listing is a different risk than reading one payment. The feed, the
// leaderboard and the transaction log each pull thousands of rows through these
// endpoints, so letting one unidentifiable record throw would blank all three
// for every user over a single bad row. Drop it with a warning instead — the
// bot's own history walk (src/services/zapHistoryService.ts) already skips rows
// it cannot key. Single-record paths keep the throw.
const sanitizePaymentPage = (payments, source) =>
  payments.flatMap((payment) => {
    try {
      return [sanitizePayment(payment)];
    } catch (error) {
      // Identifying fields only: the record itself carries memos and extra.
      // Every interpolated value is upstream- or request-controlled, so the
      // format string stays constant and they go in as arguments.
      console.warn(
        'Dropped an unusable LNbits payment:',
        error.message,
        `source=${source}`,
        `wallet_id=${payment?.wallet_id ?? 'unknown'}`,
        `time=${payment?.time ?? 'unknown'}`,
      );
      return [];
    }
  });

const listPeople = () => walletDirectory().store().list();

const listUsers = async () => listPeople().map(sanitizeUser);

const allowanceOf = (person) => walletDirectory().allowanceWallet(person);

const balanceSats = async (person) => {
  const walletId = person.allowance.walletId;
  const cached = balanceCache.get(walletId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await allowanceOf(person).getBalanceSats();
  balanceCache.set(walletId, { value, expiresAt: Date.now() + BALANCE_CACHE_MS });
  return value;
};

/** The Allowance wallet as the portal sees it; a balance read failing reads as null. */
const allowanceView = async (person) => {
  let sats = null;
  try {
    sats = await balanceSats(person);
  } catch (error) {
    console.warn('Allowance balance unavailable:', `wallet=${person.allowance.walletId}`, error.message);
  }
  return sanitizeWallet({
    id: person.allowance.walletId,
    name: ALLOWANCE_WALLET_NAME,
    user: person.oid,
    balance_msat: sats === null ? null : sats * 1000,
  });
};

/** The person's wallets as the portal sees it: their Allowance wallet. */
const listUserWallets = async (userId) => {
  const person = walletDirectory().store().get(userId);
  return person?.allowance ? [await allowanceView(person)] : [];
};

const listAllWallets = async () =>
  mapLimit(
    listPeople().filter((person) => person.allowance),
    MAX_CONCURRENT_READS,
    allowanceView,
  );

const personByWalletId = (walletId) => {
  const person = walletDirectory().store().findByAllowanceWalletId(walletId);
  if (!person) {
    throw new LnbitsGatewayError('Wallet not found', 404);
  }
  return person;
};

const findCaller = (aadObjectId) => walletDirectory().requirePerson(aadObjectId);

const assertCaller = async (aadObjectId) => {
  findCaller(aadObjectId);
};

/**
 * Adds the signed-in person to the directory (see walletDirectory.ensurePerson):
 * moves no sats. `awaitingOperator` is true until an Allowance wallet is linked.
 */
const ensureCaller = async ({ aadObjectId, displayName, email }) => {
  const result = await walletDirectory().ensurePerson({
    oid: aadObjectId,
    displayName,
    email,
  });
  return {
    user: sanitizeUser(result.person),
    created: result.created,
    createdWallets: result.createdWallets,
    awaitingOperator: result.awaitingOperator,
  };
};

const requireOwnedWallet = (walletId, aadObjectId) => {
  const person = findCaller(aadObjectId);
  if (!person.allowance || person.allowance.walletId !== walletId) {
    throw new LnbitsGatewayError('Wallet does not belong to this account', 403);
  }
  return person;
};

const getWalletDetails = async (walletId, aadObjectId) =>
  allowanceView(requireOwnedWallet(walletId, aadObjectId));

const getWalletBalance = async (walletId, aadObjectId) => {
  const person = requireOwnedWallet(walletId, aadObjectId);
  balanceCache.delete(walletId);
  return balanceSats(person);
};

/**
 * One NWC transaction in the payment shape the portal reads. Its `extra` is
 * Zaplie's record of the payment when there is one (a zap or a reward).
 */
const nwcTransactionToPayment = (tx, walletId, records) => {
  const record = records.get(String(tx.payment_hash || '').toLowerCase());
  return {
    checking_id: tx.payment_hash,
    payment_hash: tx.payment_hash,
    status: tx.state === 'pending' ? 'pending' : 'success',
    amount: (tx.type === 'outgoing' ? -1 : 1) * Math.abs(Number(tx.amount) || 0),
    fee: Number(tx.fees_paid) || 0,
    memo: record?.memo || tx.description || '',
    time: tx.settled_at || tx.created_at,
    extra: record ? toPayment(record).extra : {},
    wallet_id: walletId,
  };
};

// Deliberately tenant-wide: the team feed and the transaction log read every
// teammate's Allowance history.
const listWalletPayments = async (walletId, limit = 100) => {
  const person = personByWalletId(walletId);
  const transactions = await allowanceOf(person).listTransactions({ limit });
  const records = zapRecords().byPaymentHash();
  return sanitizePaymentPage(
    transactions
      .filter((tx) => tx && tx.state !== 'failed')
      .map((tx) => nwcTransactionToPayment(tx, walletId, records)),
    `wallet ${walletId}`,
  );
};

const getInvoicePayment = async (walletId, invoiceId, aadObjectId) => {
  const person = requireOwnedWallet(walletId, aadObjectId);
  const tx = await allowanceOf(person).lookupInvoice({ payment_hash: invoiceId });
  return {
    paid: tx?.state === 'settled',
    pending: tx?.state === 'pending',
    amount: Number(tx?.amount) || 0,
    memo: tx?.description || '',
  };
};

// Zaplie no longer holds keys to read pay links; it knows the one address
// that matters, recorded when the wallet was linked.
const getWalletPayLinks = async (walletId, aadObjectId) => {
  const person = requireOwnedWallet(walletId, aadObjectId);
  const address = person.allowance.lightningAddress;
  return address ? [{ username: address.split('@')[0], lightningAddress: address }] : [];
};

/**
 * The allowance sync's view of the directory, in the shape it has always
 * read: `{ users, total, complete }`, one entry per person keyed by Entra id.
 * The directory is local, so the list is always complete.
 */
const listDirectoryUsers = async () => {
  const users = listPeople().map((person) => ({
    id: person.oid,
    external_id: person.oid,
    extra: { display_name: person.displayName || person.oid },
  }));
  return { users, total: users.length, complete: true };
};

/**
 * A person's Allowance wallet for the allowance sync: its id and the
 * Lightning address the schedule pays. No credential.
 */
const listPersonWallets = async (userId) => {
  const person = walletDirectory().store().get(userId);
  return person?.allowance
    ? [
        {
          id: person.allowance.walletId,
          name: ALLOWANCE_WALLET_NAME,
          lightningAddress: person.allowance.lightningAddress || null,
        },
      ]
    : [];
};

const createOwnedInvoice = async ({ walletId, amount, memo, aadObjectId }) => {
  const person = requireOwnedWallet(walletId, aadObjectId);
  const invoice = await allowanceOf(person).makeInvoice({ amountSats: amount, description: memo });
  if (!validPaymentId(invoice.paymentHash) || invoice.paymentRequest.length > 4096) {
    throw new LnbitsGatewayError('The wallet did not return a complete invoice');
  }
  return { paymentRequest: invoice.paymentRequest, invoiceId: invoice.paymentHash };
};

// An Allowance wallet pays zaps only: an arbitrary invoice would skip the
// per-zap ceiling, the self-zap refusal and the Lightning address allow-list.
const payOwnedInvoice = async ({ walletId, aadObjectId }) => {
  requireOwnedWallet(walletId, aadObjectId);
  throw new LnbitsGatewayError('Allowance sats can only be sent as zaps', 403);
};

// One wording for both the moment it happens and every later retry, so support
// sees the same string whichever way the user hits it.
const OUTCOME_UNKNOWN_MESSAGE =
  'This zap may have been paid but could not be recorded. Do not retry: ' +
  'contact support to confirm whether it went through.';

/**
 * Pays once per idempotency key: the shared core of zaps and rewards.
 * `prepare()` runs after the key is reserved and returns the invoice, the
 * wallet to pay from and how to record the result. Every error leaving here
 * carries `paymentOutcome`: 'not_paid' (safe to retry, the key is released)
 * or 'unknown' (the payment may have left; never retry blind).
 */
const createIdempotentPayer = (idempotencyStore) => {
  const inFlight = new Map();

  return async ({ scope, requestHash, prepare }) => {
    const active = inFlight.get(scope);
    if (active) {
      if (active.requestHash !== requestHash) {
        throw Object.assign(
          new LnbitsGatewayError('Idempotency key was already used for another payment', 409),
          { paymentOutcome: 'not_paid' },
        );
      }
      return active.promise;
    }

    const operation = (async () => {
      const idempotency = await idempotencyStore.begin({ scope, requestHash });
      if (idempotency.state === 'replay') return idempotency.result;
      if (idempotency.state === 'pending') {
        throw new LnbitsGatewayError('Payment is already in progress', 409);
      }
      if (idempotency.state === 'failed') {
        throw Object.assign(new LnbitsGatewayError('Idempotency key cannot be retried safely', 409), {
          paymentOutcome: 'unknown',
        });
      }
      if (idempotency.state === 'outcome_unknown') {
        throw Object.assign(new LnbitsGatewayError(OUTCOME_UNKNOWN_MESSAGE, 503, { expose: true }), {
          paymentOutcome: 'unknown',
        });
      }

      let paymentAttempted = false;
      let outcomeUnknown = false;
      try {
        const { invoice, payFrom, record } = await prepare();
        // Recorded before the payment so a payment that dies mid-way still
        // leaves its invoice behind to reconcile.
        await idempotencyStore.attachPayment({
          scope,
          requestHash,
          invoiceId: invoice.invoiceId || invoice.paymentRequest.slice(0, 256),
        });
        paymentAttempted = true;
        const paid = await payFrom.payInvoice(invoice.paymentRequest);
        const result = { payment_hash: paid.paymentHash, checking_id: paid.paymentHash };
        try {
          record(paid);
        } catch (recordError) {
          // The money has left; a missing feed entry must not read as unpaid.
          console.error('Zap record could not be written', recordError.message);
        }
        try {
          await idempotencyStore.complete({ scope, requestHash, result });
        } catch (persistError) {
          console.error('Payment idempotency completion could not be persisted', persistError);
          outcomeUnknown = true;
          try {
            await idempotencyStore.markOutcomeUnknown({ scope, requestHash, result });
          } catch (markError) {
            console.error('Payment idempotency outcome could not be marked unknown', markError);
          }
          throw new LnbitsGatewayError(OUTCOME_UNKNOWN_MESSAGE, 503, { expose: true });
        }
        return result;
      } catch (error) {
        // The wallet's definite refusal proves nothing was paid, so the key
        // is released like any failure before the payment.
        const notPaid = !paymentAttempted || error instanceof NwcPaymentRefused;
        try {
          if (!outcomeUnknown) {
            if (notPaid) {
              await idempotencyStore.release({ scope, requestHash });
            } else {
              await idempotencyStore.fail({ scope, requestHash });
            }
          }
        } catch (persistError) {
          console.error('Payment idempotency outcome could not be persisted', persistError);
        }
        if (error instanceof NwcPaymentUnknown) {
          throw Object.assign(new LnbitsGatewayError(OUTCOME_UNKNOWN_MESSAGE, 503, { expose: true }), {
            paymentOutcome: 'unknown',
          });
        }
        error.paymentOutcome = notPaid && !outcomeUnknown ? 'not_paid' : 'unknown';
        throw error;
      }
    })();

    inFlight.set(scope, { requestHash, promise: operation });
    try {
      return await operation;
    } finally {
      if (inFlight.get(scope)?.promise === operation) {
        inFlight.delete(scope);
      }
    }
  };
};

const createSendZap = ({
  findCallerForZap = findCaller,
  findRecipientForZap = (oid) => walletDirectory().store().get(oid),
  walletForZap = allowanceOf,
  createInvoiceForZap = (recipient, amount, memo) =>
    walletDirectory().createInvoiceFor(recipient.oid, { amountSats: amount, memo }),
  recordZap = (entry) => zapRecords().record(entry),
  idempotencyStore = createZapIdempotencyStore(),
} = {}) => {
  const pay = createIdempotentPayer(idempotencyStore);

  return async ({ recipientUserId, amount, memo, aadObjectId, idempotencyKey, source = 'portal' }) => {
    const maxAmount = maxZapAmountSats();
    const recipientOid = normalizeOid(recipientUserId);
    if (
      !recipientOid ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > maxAmount ||
      typeof memo !== 'string' ||
      memo.trim().length === 0 ||
      memo.length > 500 ||
      typeof aadObjectId !== 'string' ||
      aadObjectId.length === 0 ||
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey || '')
    ) {
      throw Object.assign(new LnbitsGatewayError('Invalid zap request', 400), { paymentOutcome: 'not_paid' });
    }

    let sender;
    try {
      sender = await findCallerForZap(aadObjectId);
      if (recipientOid === sender.oid) {
        throw new LnbitsGatewayError('A user cannot zap their own account', 409);
      }
    } catch (error) {
      error.paymentOutcome = 'not_paid';
      throw error;
    }

    return pay({
      scope: idempotencyStore.scopeDigest({ aadObjectId, idempotencyKey }),
      requestHash: idempotencyStore.requestDigest({ recipientUserId: recipientOid, amount, memo }),
      prepare: async () => {
        const senderWallet = walletForZap(sender);
        if (!senderWallet) {
          throw new LnbitsGatewayError('Your Allowance wallet has not been set up yet', 409, { expose: true });
        }
        const recipient = await findRecipientForZap(recipientOid);
        if (!recipient) {
          throw new LnbitsGatewayError('Recipient is not registered with Zaplie', 409);
        }
        const senderBalance = await senderWallet.getBalanceSats();
        if (!Number.isFinite(senderBalance) || senderBalance < amount) {
          throw new LnbitsGatewayError('Insufficient allowance balance', 409, { expose: true });
        }
        const invoice = await createInvoiceForZap(recipient, amount, memo);
        return {
          invoice,
          payFrom: senderWallet,
          record: (paid) =>
            recordZap({
              paymentHash: paid.paymentHash,
              kind: 'zap',
              source,
              amountSats: amount,
              memo,
              from: { oid: sender.oid, displayName: sender.displayName || sender.oid, walletId: sender.allowance.walletId },
              to: { oid: recipient.oid, displayName: recipient.displayName || recipient.oid },
            }),
        };
      },
    });
  };
};

const sendZap = createSendZap();

const TREASURY_SCOPE = 'treasury';
const TREASURY_DISPLAY_NAME = 'Automation';

/**
 * Pays an automation reward from the Treasury to a person's Lightning
 * address, once per idempotency key, and records it. The bot decides the
 * amount and enforces the budget; this only pays.
 */
const createPayReward = ({
  findRecipient = (oid) => walletDirectory().store().get(oid),
  treasuryWallet = () => walletDirectory().treasuryWallet(),
  createInvoiceForReward = (recipient, amount, memo) =>
    walletDirectory().createInvoiceFor(recipient.oid, { amountSats: amount, memo }),
  recordReward = (entry) => zapRecords().record(entry),
  idempotencyStore = createZapIdempotencyStore(),
} = {}) => {
  const pay = createIdempotentPayer(idempotencyStore);

  return async ({ recipientOid: oidInput, recipientLabel, amountSats, memo, reward = {}, idempotencyKey }) => {
    const recipientOid = normalizeOid(oidInput);
    if (
      !recipientOid ||
      !Number.isSafeInteger(amountSats) ||
      amountSats <= 0 ||
      typeof memo !== 'string' ||
      memo.length > 500 ||
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey || '')
    ) {
      throw Object.assign(new LnbitsGatewayError('Invalid reward payment', 400), { paymentOutcome: 'not_paid' });
    }
    return pay({
      scope: idempotencyStore.scopeDigest({ aadObjectId: TREASURY_SCOPE, idempotencyKey }),
      requestHash: idempotencyStore.requestDigest({ recipientUserId: recipientOid, amount: amountSats, memo }),
      prepare: async () => {
        const recipient = await findRecipient(recipientOid);
        if (!recipient) throw new LnbitsGatewayError('Recipient is not registered with Zaplie', 409);
        const payFrom = treasuryWallet();
        const invoice = await createInvoiceForReward(recipient, amountSats, memo);
        return {
          invoice,
          payFrom,
          record: (paid) =>
            recordReward({
              paymentHash: paid.paymentHash,
              kind: 'reward',
              source: 'bot',
              amountSats,
              memo,
              from: { displayName: TREASURY_DISPLAY_NAME },
              to: { oid: recipient.oid, displayName: recipientLabel || recipient.displayName || recipient.oid },
              reward,
            }),
        };
      },
    });
  };
};

const payReward = createPayReward();

/**
 * The rewards store lists products of a nostrmarket stall. nostrmarket is not
 * installed on every LNbits instance (it is not on bank.knowall.ai since the
 * 1.7 rebuild), so the store is off unless ZAPLIE_REWARDS_STORE_ENABLED=true,
 * and an instance without the extension (404) reads as an empty store rather
 * than an outage.
 */
const rewardsStoreEnabled = (env = process.env) =>
  String(env.ZAPLIE_REWARDS_STORE_ENABLED || '').trim().toLowerCase() === 'true';

const getNostrRewards = async (stallId) => {
  if (!rewardsStoreEnabled()) {
    return [];
  }
  const walletKey = rewardsStoreInkey();
  if (!walletKey) {
    throw new LnbitsGatewayError('ZAPLIE_REWARDS_STORE_INKEY must be set for the rewards store', 503);
  }
  let rewards;
  try {
    rewards = await lnbitsRequest(
      `/nostrmarket/api/v1/stall/product/${encodeURIComponent(stallId)}`,
      { walletKey },
    );
  } catch (error) {
    if (error.upstreamStatus === 404) {
      console.warn('Rewards store unavailable: the nostrmarket extension answered 404');
      return [];
    }
    throw error;
  }
  if (!Array.isArray(rewards)) {
    throw new LnbitsGatewayError('LNbits rewards response is malformed');
  }
  return rewards.map((reward) => ({
    id: reward.id,
    image: reward.image || (Array.isArray(reward.images) ? reward.images[0] : ''),
    name: reward.name,
    shortDescription:
      reward.shortDescription || reward.description || reward.config?.description || '',
    link:
      reward.link ||
      (Array.isArray(reward.categories) ? reward.categories[0] : reward.categories) ||
      '',
    price: Number(reward.price || 0),
  }));
};

/**
 * Every zap and reward Zaplie paid, as payments, newest first: the feed's
 * and the leaderboards' source. Each is the sending leg only (an Allowance
 * wallet, or the Treasury for a reward) with Zaplie's metadata in `extra`.
 */
const getAllPayments = async ({ limit = 1000, offset = 0, direction = 'desc' }) => {
  const records = zapRecords().list();
  if (direction === 'asc') records.reverse();
  return sanitizePaymentPage(
    records.slice(offset, offset + limit).map(toPayment),
    'the zap records',
  );
};

const resetCachesForTests = () => {
  balanceCache.clear();
};

module.exports = {
  ALLOWANCE_WALLET_NAME,
  LnbitsGatewayError,
  OUTCOME_UNKNOWN_MESSAGE,
  assertCaller,
  createIdempotentPayer,
  createOwnedInvoice,
  createPayReward,
  createSendZap,
  ensureCaller,
  getAllPayments,
  getInvoicePayment,
  getNostrRewards,
  getWalletBalance,
  getWalletDetails,
  getWalletPayLinks,
  listAllWallets,
  listDirectoryUsers,
  listPersonWallets,
  listUserWallets,
  listUsers,
  listWalletPayments,
  lnbitsRequest,
  maskKeys,
  maxZapAmountSats,
  nwcTransactionToPayment,
  payOwnedInvoice,
  payReward,
  redactSensitive,
  resetCachesForTests,
  rewardsStoreEnabled,
  sanitizeBalanceMsat,
  sanitizePayment,
  sanitizeUser,
  sanitizeWallet,
  sendZap,
};
