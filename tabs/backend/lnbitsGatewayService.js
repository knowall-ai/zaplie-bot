// The portal's server-side view of LNbits. People and their wallets come from
// Zaplie's own directory (walletDirectory.js / peopleStore.js); LNbits is only
// ever called with a wallet key, or with the optional zaplie.service API token
// for the few account-level reads (docs/LNBITS_MIGRATION.adoc).
const { lnbitsApiToken, treasuryInkey } = require('./lnbitsConfig');
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

/** A person's Allowance wallet, keys included, for server-side use only. */
const keyedAllowanceWallet = (person) =>
  person.allowance
    ? {
        id: person.allowance.walletId,
        name: ALLOWANCE_WALLET_NAME,
        user: person.oid,
        adminkey: person.allowance.adminkey,
        inkey: person.allowance.inkey,
      }
    : null;

const listPeople = () => walletDirectory().store().list();

const listUsers = async () => listPeople().map(sanitizeUser);

const walletBalanceMsat = async (wallet) => {
  const cached = balanceCache.get(wallet.id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const details = await lnbitsRequest('/api/v1/wallet', { walletKey: wallet.inkey });
  const value = sanitizeBalanceMsat(details?.balance);
  balanceCache.set(wallet.id, { value, expiresAt: Date.now() + BALANCE_CACHE_MS });
  return value;
};

// With the API token one account-level read returns every zaplie.service
// wallet with its balance; without it, one read per wallet (cached briefly).
const withBalances = async (wallets) => {
  if (wallets.length === 0) return [];
  if (lnbitsApiToken()) {
    const owned = await walletDirectory().listServiceWallets();
    const byId = new Map(owned.map((wallet) => [wallet.id, wallet.balance_msat]));
    return wallets.map((wallet) => ({ ...wallet, balance_msat: byId.get(wallet.id) ?? null }));
  }
  return mapLimit(wallets, MAX_CONCURRENT_READS, async (wallet) => {
    try {
      return { ...wallet, balance_msat: await walletBalanceMsat(wallet) };
    } catch (error) {
      console.warn('Allowance balance unavailable:', `wallet=${wallet.id}`, error.message);
      return { ...wallet, balance_msat: null };
    }
  });
};

/** The person's wallets as the portal sees them: their Allowance wallet. */
const listUserWallets = async (userId) => {
  const person = walletDirectory().store().get(userId);
  const wallet = person && keyedAllowanceWallet(person);
  return (await withBalances(wallet ? [wallet] : [])).map(sanitizeWallet);
};

const listAllWallets = async () =>
  (await withBalances(listPeople().map(keyedAllowanceWallet).filter(Boolean))).map(
    sanitizeWallet,
  );

const getWalletWithKeys = (walletId) => {
  const person = walletDirectory().store().findByAllowanceWalletId(walletId);
  if (!person) {
    throw new LnbitsGatewayError('Wallet not found', 404);
  }
  return keyedAllowanceWallet(person);
};

const findCaller = (aadObjectId) => walletDirectory().requirePerson(aadObjectId);

const assertCaller = async (aadObjectId) => {
  findCaller(aadObjectId);
};

/**
 * Provisions the signed-in person (see walletDirectory.ensurePerson): moves no
 * sats. `awaitingOperator` is true when no API token is configured and an
 * operator still has to link their Allowance wallet.
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
  const wallet = keyedAllowanceWallet(findCaller(aadObjectId));
  if (!wallet || wallet.id !== walletId) {
    throw new LnbitsGatewayError('Wallet does not belong to this account', 403);
  }
  return wallet;
};

const getWalletDetails = async (walletId, aadObjectId) => {
  const wallet = requireOwnedWallet(walletId, aadObjectId);
  const details = await lnbitsRequest('/api/v1/wallet', { walletKey: wallet.inkey });
  return sanitizeWallet({ ...wallet, balance_msat: details?.balance });
};

const walletBalanceSats = async (wallet) => {
  const details = await lnbitsRequest('/api/v1/wallet', { walletKey: wallet.inkey });
  return Number(details.balance || 0) / 1000;
};

const getWalletBalance = async (walletId, aadObjectId) =>
  walletBalanceSats(requireOwnedWallet(walletId, aadObjectId));

// Deliberately tenant-wide: the team feed and the transaction log build their
// history from every teammate's Allowance wallet.
const listWalletPayments = async (walletId, limit = 100) => {
  const wallet = getWalletWithKeys(walletId);
  const payments = await lnbitsRequest(`/api/v1/payments?limit=${limit}`, {
    walletKey: wallet.inkey,
  });
  if (!Array.isArray(payments)) {
    throw new LnbitsGatewayError('LNbits payments response is malformed');
  }
  return sanitizePaymentPage(payments, `wallet ${walletId}`);
};

const getInvoicePayment = async (walletId, invoiceId, aadObjectId) => {
  const wallet = requireOwnedWallet(walletId, aadObjectId);
  return redactSensitive(
    await lnbitsRequest(`/api/v1/payments/${encodeURIComponent(invoiceId)}`, {
      walletKey: wallet.inkey,
    }),
  );
};

const getWalletPayLinks = async (walletId, aadObjectId) => {
  const wallet = requireOwnedWallet(walletId, aadObjectId);
  return redactSensitive(
    await lnbitsRequest(
      `/lnurlp/api/v1/links?all_wallets=false&wallet=${encodeURIComponent(walletId)}`,
      { walletKey: wallet.inkey },
    ),
  );
};

// Pay links on a wallet the server already holds keys for (the allowance sync
// walks every Allowance wallet). Listing takes the invoice key; creating and
// updating take the wallet's admin key, as the lnurlp extension requires.
const listWalletPayLinksWithKey = async (wallet) => {
  const links = await lnbitsRequest('/lnurlp/api/v1/links?all_wallets=false', {
    walletKey: wallet.inkey,
    readErrorDetail: true,
  });
  if (!Array.isArray(links)) {
    throw new LnbitsGatewayError('LNbits pay links response is malformed');
  }
  return links.map(redactSensitive);
};

const createWalletPayLink = async (wallet, body) =>
  redactSensitive(
    await lnbitsRequest('/lnurlp/api/v1/links', {
      method: 'POST',
      walletKey: wallet.adminkey,
      body,
      readErrorDetail: true,
    }),
  );

const updateWalletPayLink = async (wallet, linkId, body) =>
  redactSensitive(
    await lnbitsRequest(`/lnurlp/api/v1/links/${encodeURIComponent(linkId)}`, {
      method: 'PUT',
      walletKey: wallet.adminkey,
      body,
      readErrorDetail: true,
    }),
  );

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

/** A person's Allowance wallet with keys, for the allowance sync. */
const listPersonWalletsWithKeys = async (userId) => {
  const person = walletDirectory().store().get(userId);
  const wallet = person && keyedAllowanceWallet(person);
  return wallet ? [wallet] : [];
};

const createInvoice = async (wallet, amount, memo) => {
  const result = await lnbitsRequest('/api/v1/payments', {
    method: 'POST',
    walletKey: wallet.inkey,
    body: { out: false, amount, memo },
  });
  const paymentRequest = result.payment_request;
  const invoiceId = validPaymentId(result.checking_id)
    ? result.checking_id
    : result.payment_hash;
  if (
    typeof paymentRequest !== 'string' ||
    paymentRequest.length === 0 ||
    paymentRequest.length > 4096 ||
    !validPaymentId(invoiceId)
  ) {
    throw new LnbitsGatewayError(
      'LNbits did not return a complete invoice',
    );
  }
  return { paymentRequest, invoiceId };
};

const createOwnedInvoice = async ({ walletId, amount, memo, aadObjectId }) =>
  createInvoice(requireOwnedWallet(walletId, aadObjectId), amount, memo);

const payInvoice = async (wallet, paymentRequest, extra) => {
  const result = await lnbitsRequest('/api/v1/payments', {
    method: 'POST',
    walletKey: wallet.adminkey,
    body: { out: true, bolt11: paymentRequest, ...(extra ? { extra } : {}) },
  });
  const paymentId = validPaymentId(result.payment_hash)
    ? result.payment_hash
    : result.checking_id;
  if (!validPaymentId(paymentId)) {
    throw new LnbitsGatewayError(
      'LNbits did not return a payment identifier',
    );
  }
  return {
    payment_hash: validPaymentId(result.payment_hash)
      ? result.payment_hash
      : paymentId,
    checking_id: validPaymentId(result.checking_id)
      ? result.checking_id
      : paymentId,
  };
};

// The only wallet a caller owns here is their Allowance wallet, and its sats
// are for recognising other people. They leave it as zaps (sendZap), which
// name a registered recipient and are bounded by the zap ceiling and the
// Lightning address allow-list. Paying an arbitrary invoice from it would
// bypass all three, so it is refused; a person spends their own money from
// their own Private wallet, which Zaplie holds no key for.
const payOwnedInvoice = async ({ walletId, aadObjectId }) => {
  requireOwnedWallet(walletId, aadObjectId);
  throw new LnbitsGatewayError('Allowance sats can only be sent as zaps', 403);
};

/**
 * The payment metadata the feed reads. Only names and ids: never a key.
 * The recipient is identified by Entra id, because Zaplie does not know (and
 * must not need) the id of the Private wallet the zap lands in.
 */
const zapExtra = (sender, senderWallet, recipient) => ({
  tag: 'zap',
  from: {
    id: senderWallet.id,
    name: ALLOWANCE_WALLET_NAME,
    user: sender.oid,
    displayName: sender.displayName || sender.oid,
  },
  to: {
    name: 'Private',
    user: recipient.oid,
    displayName: recipient.displayName || recipient.oid,
  },
});

// One wording for both the moment it happens and every later retry, so support
// sees the same string whichever way the user hits it.
const OUTCOME_UNKNOWN_MESSAGE =
  'This zap may have been paid but could not be recorded. Do not retry: ' +
  'contact support to confirm whether it went through.';

const createSendZap = ({
  findCallerForZap = findCaller,
  findRecipientForZap = (oid) => walletDirectory().store().get(oid),
  getBalanceForZap = walletBalanceSats,
  createInvoiceForZap = (recipient, amount, memo, extra) =>
    walletDirectory().createInvoiceFor(recipient.oid, { amountSats: amount, memo, extra }),
  payInvoiceForZap = payInvoice,
  idempotencyStore = createZapIdempotencyStore(),
} = {}) => {
  const inFlight = new Map();

  return async ({
    recipientUserId,
    amount,
    memo,
    aadObjectId,
    idempotencyKey,
  }) => {
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
      throw new LnbitsGatewayError('Invalid zap request', 400);
    }

    const scope = idempotencyStore.scopeDigest({
      aadObjectId,
      idempotencyKey,
    });
    const requestHash = idempotencyStore.requestDigest({
      recipientUserId: recipientOid,
      amount,
      memo,
    });
    const active = inFlight.get(scope);
    if (active) {
      if (active.requestHash !== requestHash) {
        throw new LnbitsGatewayError(
          'Idempotency key was already used for another zap',
          409,
        );
      }
      return active.promise;
    }

    const operation = (async () => {
      const sender = await findCallerForZap(aadObjectId);
      if (recipientOid === sender.oid) {
        throw new LnbitsGatewayError('A user cannot zap their own account', 409);
      }

      const idempotency = await idempotencyStore.begin({ scope, requestHash });
      if (idempotency.state === 'replay') {
        return idempotency.result;
      }
      if (idempotency.state === 'pending') {
        throw new LnbitsGatewayError('Zap request is already in progress', 409);
      }
      if (idempotency.state === 'failed') {
        throw new LnbitsGatewayError(
          'Idempotency key cannot be retried safely',
          409,
        );
      }
      if (idempotency.state === 'outcome_unknown') {
        throw new LnbitsGatewayError(OUTCOME_UNKNOWN_MESSAGE, 503, {
          expose: true,
        });
      }

      let paymentAttempted = false;
      let outcomeUnknown = false;
      try {
        const senderWallet = keyedAllowanceWallet(sender);
        if (!senderWallet) {
          throw new LnbitsGatewayError(
            'Your Allowance wallet has not been set up yet',
            409,
            { expose: true },
          );
        }

        const recipient = await findRecipientForZap(recipientOid);
        if (!recipient) {
          throw new LnbitsGatewayError('Recipient is not registered with Zaplie', 409);
        }

        const senderBalance = await getBalanceForZap(senderWallet);
        if (!Number.isFinite(senderBalance) || senderBalance < amount) {
          throw new LnbitsGatewayError('Insufficient allowance balance', 409);
        }

        const extra = zapExtra(sender, senderWallet, recipient);
        const invoice = await createInvoiceForZap(recipient, amount, memo, extra);
        // Recorded before the payment so a zap that dies mid-payment still
        // leaves the invoice behind to reconcile against LNbits. An invoice
        // from a Lightning address has no LNbits id on our side, so the
        // payment request itself is what support reconciles by.
        await idempotencyStore.attachPayment({
          scope,
          requestHash,
          invoiceId: invoice.invoiceId || invoice.paymentRequest.slice(0, 256),
        });
        paymentAttempted = true;
        const result = await payInvoiceForZap(
          senderWallet,
          invoice.paymentRequest,
          extra,
        );
        try {
          await idempotencyStore.complete({ scope, requestHash, result });
        } catch (persistError) {
          console.error(
            'Zap idempotency completion could not be persisted',
            persistError,
          );
          // The money has left. Swallowing this would report success for a zap
          // nothing recorded, and leaving the record pending would wedge every
          // retry on "already in progress" forever, so mark it unknown and say
          // so instead of guessing either way.
          outcomeUnknown = true;
          try {
            await idempotencyStore.markOutcomeUnknown({
              scope,
              requestHash,
              result,
            });
          } catch (markError) {
            console.error(
              'Zap idempotency outcome could not be marked unknown',
              markError,
            );
          }
          throw new LnbitsGatewayError(OUTCOME_UNKNOWN_MESSAGE, 503, {
            expose: true,
          });
        }
        return result;
      } catch (error) {
        try {
          // `outcomeUnknown` means the payment went through and only recording
          // it failed. Marking that `failed` would be a lie even when
          // markOutcomeUnknown itself failed: `failed` reads as "not paid" and
          // replays as "cannot be retried safely", when the money has almost
          // certainly gone. Leaving the record pending or unknown keeps it
          // reconcilable, so this path touches the store no further.
          if (!outcomeUnknown) {
            if (paymentAttempted) {
              await idempotencyStore.fail({ scope, requestHash });
            } else {
              // No payment was attempted, so the key is safe to retry.
              await idempotencyStore.release({ scope, requestHash });
            }
          }
        } catch (persistError) {
          console.error(
            'Zap idempotency outcome could not be persisted',
            persistError,
          );
        }
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

const sendZap = createSendZap();

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
  const walletKey = treasuryInkey();
  if (!walletKey) {
    throw new LnbitsGatewayError('ZAPLIE_TREASURY_INKEY must be set for the rewards store', 503);
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

const paymentTime = (payment) =>
  typeof payment.time === 'number' ? payment.time : Date.parse(payment.time) / 1000 || 0;

/**
 * Every payment Zaplie can see, newest first. With the API token that is one
 * paged read of zaplie.service's payments (every Allowance wallet, the Fund
 * and the Treasury). Without it, each known wallet is read with its invoice
 * key and the pages are merged here.
 */
const getAllPayments = async ({ limit = 1000, offset = 0, direction = 'desc' }) => {
  const order = direction === 'asc' ? 'asc' : 'desc';
  if (lnbitsApiToken()) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      sortby: 'time',
      direction: order,
    });
    const body = await lnbitsRequest(`/api/v1/payments/all/paginated?${params}`, {
      apiToken: true,
    });
    const payments = Array.isArray(body)
      ? body
      : body?.data || body?.payments || body?.items;
    if (!Array.isArray(payments)) {
      throw new LnbitsGatewayError('LNbits payments response is malformed');
    }
    return sanitizePaymentPage(payments, 'the zaplie.service payments page');
  }

  const keys = listPeople()
    .map((person) => person.allowance?.inkey)
    .filter(Boolean);
  const treasury = treasuryInkey();
  if (treasury) keys.push(treasury);
  const window = Math.min(offset + limit, 1000);
  const lists = await mapLimit(keys, MAX_CONCURRENT_READS, async (walletKey) => {
    const page = await lnbitsRequest(`/api/v1/payments?limit=${window}`, { walletKey });
    return Array.isArray(page) ? page : [];
  });
  const merged = lists.flat().sort((a, b) =>
    order === 'asc' ? paymentTime(a) - paymentTime(b) : paymentTime(b) - paymentTime(a),
  );
  return sanitizePaymentPage(merged.slice(offset, offset + limit), 'the merged wallet payments');
};

const resetCachesForTests = () => {
  balanceCache.clear();
};

module.exports = {
  ALLOWANCE_WALLET_NAME,
  LnbitsGatewayError,
  assertCaller,
  createInvoice,
  createSendZap,
  createOwnedInvoice,
  createWalletPayLink,
  ensureCaller,
  getAllPayments,
  getInvoicePayment,
  getNostrRewards,
  getWalletBalance,
  getWalletDetails,
  getWalletPayLinks,
  listAllWallets,
  listDirectoryUsers,
  listPersonWalletsWithKeys,
  listUserWallets,
  listUsers,
  listWalletPayLinksWithKey,
  listWalletPayments,
  lnbitsRequest,
  maskKeys,
  maxZapAmountSats,
  payOwnedInvoice,
  redactSensitive,
  resetCachesForTests,
  rewardsStoreEnabled,
  sanitizeBalanceMsat,
  sanitizePayment,
  sanitizeUser,
  sanitizeWallet,
  sendZap,
  updateWalletPayLink,
  zapExtra,
};
