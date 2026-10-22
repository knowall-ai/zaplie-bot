const {
  REQUEST_TIMEOUT_MS,
  getLnbitsToken,
  requireLnbitsConfig,
} = require('./lnbitsAdmin');
const {
  findUniqueUserByAadObjectId,
  parseExtra,
} = require('./lnbitsUserDirectory');
const { positiveIntFromEnv } = require('./rewardAmounts');
const {
  createZapIdempotencyStore,
} = require('./lnbitsZapIdempotencyStore');

const TOKEN_CACHE_MS = 5 * 60 * 1000;
const WALLET_CACHE_MS = 30 * 1000;
const SENSITIVE_FIELD = /(adminkey|inkey|admin.?key|invoice.?key|password|preimage|secret|token)/i;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

let tokenCache = null;
let tokenRequest = null;
const walletCache = new Map();
let walletIndex = null;

class LnbitsGatewayError extends Error {
  // 5xx messages are masked by the router so LNbits internals never reach the
  // browser. `expose` opts a message back in, for the few 5xx cases where the
  // user has to be told something specific rather than "try again".
  constructor(message, status = 502, { expose = false } = {}) {
    super(message);
    this.name = 'LnbitsGatewayError';
    this.status = status;
    this.expose = expose;
  }
}

const requireGatewayConfig = () => ({
  ...requireLnbitsConfig(),
  adminKey: process.env.LNBITS_ADMINKEY || '',
});

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

// The cache expiring under load must not turn one super-user login into N of
// them: everyone who arrives while a login is in flight awaits that same
// promise, and the slot is cleared on settle so a failure is retried, not cached.
const getAccessToken = async (config) => {
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.value;
  }
  if (!tokenRequest) {
    // The clear lives in a finally on the request itself, not in a chained
    // then: a finally callback runs before the promise the caller awaits
    // settles, so a caller that retries the instant it sees the rejection
    // starts a fresh login instead of re-awaiting the rejected one.
    const request = getLnbitsToken(config)
      .then((value) => {
        tokenCache = { value, expiresAt: Date.now() + TOKEN_CACHE_MS };
        return value;
      })
      .finally(() => {
        if (tokenRequest === request) {
          tokenRequest = null;
        }
      });
    tokenRequest = request;
  }
  return tokenRequest;
};

const safeJson = async (response) => {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new LnbitsGatewayError('LNbits returned a non-JSON response');
  }
  return response.json();
};

const lnbitsRequest = async (path, options = {}) => {
  const config = requireGatewayConfig();
  const headers = {
    accept: 'application/json',
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
  };

  if (options.walletKey) {
    headers['X-Api-Key'] = options.walletKey;
  } else if (options.adminKey) {
    if (!config.adminKey) {
      throw new LnbitsGatewayError('LNbits admin key is not configured', 503);
    }
    headers['X-Api-Key'] = config.adminKey;
  } else {
    headers.Authorization = `Bearer ${await getAccessToken(config)}`;
  }

  let response;
  try {
    response = await fetch(`${config.nodeUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new LnbitsGatewayError('LNbits request timed out', 502);
    }
    throw error;
  }

  if (!response.ok) {
    if (!options.walletKey && !options.adminKey && response.status === 401) {
      tokenCache = null;
    }
    // Only genuine caller mistakes are propagated. An LNbits 401/403 means the
    // gateway's own credentials failed, which is a 502 for the browser.
    const status =
      response.status === 400 || response.status === 404 ? response.status : 502;
    throw new LnbitsGatewayError(
      `LNbits request failed with status ${response.status}`,
      status,
    );
  }
  return safeJson(response);
};

const redactSensitive = (value, depth = 0) => {
  if (depth > 8 || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_FIELD.test(key))
      .map(([key, nested]) => [key, redactSensitive(nested, depth + 1)]),
  );
};

const sanitizeUser = (user) => {
  const extra = parseExtra(user);
  // Users created by the portal carry their name only in extra.display_name.
  let displayName = String(
    user.username || user.name || extra.display_name || user.id || '',
  );
  if (displayName.includes('@')) {
    displayName = displayName
      .split('@')[0]
      .replace('.', ' ')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  return {
    id: user.id,
    displayName,
    profileImg: extra.profileImg || '',
    aadObjectId: user.external_id || extra.aadObjectId || '',
    email: user.email || extra.email || user.username || '',
    type: extra.type || 'Teammate',
    privateWallet: null,
    allowanceWallet: null,
  };
};

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

const listRawUsers = async () => {
  const body = await lnbitsRequest('/users/api/v1/user');
  const users = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(users)) {
    throw new LnbitsGatewayError('LNbits users response is malformed');
  }
  return users;
};

const listUsers = async () => (await listRawUsers()).map(sanitizeUser);

const cacheWallet = (wallet) => {
  if (wallet?.id && wallet?.inkey && wallet?.adminkey) {
    walletCache.set(wallet.id, {
      wallet,
      expiresAt: Date.now() + WALLET_CACHE_MS,
    });
  }
};

const listUserWalletsWithKeys = async (userId) => {
  const wallets = await lnbitsRequest(
    `/users/api/v1/user/${encodeURIComponent(userId)}/wallet`,
  );
  if (!Array.isArray(wallets)) {
    throw new LnbitsGatewayError('LNbits wallets response is malformed');
  }
  const active = wallets.filter((wallet) => wallet.deleted !== true);
  active.forEach(cacheWallet);
  return active;
};

const listUserWallets = async (userId) =>
  (await listUserWalletsWithKeys(userId)).map(sanitizeWallet);

const buildWalletIndex = async () => {
  const index = new Map();
  for (const user of await listRawUsers()) {
    for (const wallet of await listUserWalletsWithKeys(user.id)) {
      index.set(wallet.id, wallet);
    }
  }
  return index;
};

// The feed reads every teammate's wallet at once, so one shared walk per cache
// window replaces a per-request walk costing an upstream call per user.
const getWalletIndex = () => {
  if (walletIndex && walletIndex.expiresAt > Date.now()) {
    return walletIndex.entries;
  }
  const entry = { expiresAt: Date.now() + WALLET_CACHE_MS };
  entry.entries = buildWalletIndex().catch((error) => {
    if (walletIndex === entry) {
      walletIndex = null;
    }
    throw error;
  });
  walletIndex = entry;
  return entry.entries;
};

const getWalletWithKeys = async (walletId) => {
  const cached = walletCache.get(walletId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.wallet;
  }
  walletCache.delete(walletId);

  const wallet = (await getWalletIndex()).get(walletId);
  if (!wallet) {
    throw new LnbitsGatewayError('Wallet not found', 404);
  }
  return wallet;
};

const listAllWallets = async () => {
  const wallets = [];
  for (const user of await listRawUsers()) {
    wallets.push(...(await listUserWallets(user.id)));
  }
  return wallets;
};

const findCaller = async (aadObjectId) => {
  const user = findUniqueUserByAadObjectId(await listRawUsers(), aadObjectId);
  if (!user) {
    throw new LnbitsGatewayError('No LNbits user is linked to this account', 403);
  }
  return user;
};

const assertCaller = async (aadObjectId) => {
  await findCaller(aadObjectId);
};

// The bot provisions an LNbits user (and the Allowance and Private wallets) on
// a person's first Teams turn. Outside Teams nothing did, so someone signing
// in to the portal with a work account that had never met the bot was refused
// by assertCaller on every route, the user directory included. This creates
// only what is missing, the way the bot does (the Entra oid in external_id,
// wallets matched by name), and moves no sats: the opening allowance is the
// bot's treasury decision (LNBITS_INITIAL_ALLOWANCE), not the portal's, so a
// wallet created here starts empty.
const CALLER_WALLET_NAMES = ['Allowance', 'Private'];
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;

const createLnbitsUser = async ({ aadObjectId, displayName, email }) => {
  const user = await lnbitsRequest('/users/api/v1/user', {
    method: 'POST',
    body: {
      ...(email ? { email } : {}),
      external_id: aadObjectId,
      extra: { ...(displayName ? { display_name: displayName } : {}) },
    },
  });
  if (!user || typeof user.id !== 'string' || !USER_ID_PATTERN.test(user.id)) {
    throw new LnbitsGatewayError('LNbits user response is malformed');
  }
  return user;
};

const createLnbitsWallet = async (userId, name) => {
  const wallet = await lnbitsRequest(
    `/users/api/v1/user/${encodeURIComponent(userId)}/wallet`,
    { method: 'POST', body: { name } },
  );
  if (!wallet || typeof wallet.id !== 'string') {
    throw new LnbitsGatewayError('LNbits wallet response is malformed');
  }
  return wallet;
};

const cleanClaim = (value, maxLength) =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, maxLength)
    : undefined;

const createEnsureCaller = ({
  listUsersForCaller = listRawUsers,
  createUserForCaller = createLnbitsUser,
  listWalletsForCaller = listUserWalletsWithKeys,
  createWalletForCaller = createLnbitsWallet,
} = {}) => {
  // Two tabs signing in at once must not create two LNbits users for one
  // person (findUniqueUserByAadObjectId would then refuse them both), so
  // concurrent calls for the same oid share one operation. This map lives in
  // one process: the portal backend runs as a single App Service instance
  // (like its other in-memory caches), and a second instance could still
  // race a first sign-in.
  const inFlight = new Map();

  return async ({ aadObjectId, displayName, email }) => {
    if (typeof aadObjectId !== 'string' || !USER_ID_PATTERN.test(aadObjectId)) {
      throw new LnbitsGatewayError('invalid caller', 400);
    }
    const active = inFlight.get(aadObjectId);
    if (active) {
      return active;
    }

    const operation = (async () => {
      let user = findUniqueUserByAadObjectId(
        await listUsersForCaller(),
        aadObjectId,
      );
      let created = false;
      if (!user) {
        user = await createUserForCaller({
          aadObjectId,
          displayName: cleanClaim(displayName, MAX_DISPLAY_NAME_LENGTH),
          email: cleanClaim(email, MAX_EMAIL_LENGTH),
        });
        created = true;
      }

      const existing = new Set(
        (await listWalletsForCaller(user.id)).map((wallet) =>
          String(wallet.name).trim().toLowerCase(),
        ),
      );
      const createdWallets = [];
      for (const name of CALLER_WALLET_NAMES) {
        if (!existing.has(name.toLowerCase())) {
          await createWalletForCaller(user.id, name);
          createdWallets.push(name);
        }
      }
      if (created || createdWallets.length > 0) {
        // The feed's shared wallet walk must see the new wallets.
        walletIndex = null;
      }
      return { user: sanitizeUser(user), created, createdWallets };
    })().finally(() => {
      inFlight.delete(aadObjectId);
    });

    inFlight.set(aadObjectId, operation);
    return operation;
  };
};

const ensureCaller = createEnsureCaller();

const requireOwnedWallet = async (walletId, aadObjectId) => {
  const user = await findCaller(aadObjectId);
  const wallet = (await listUserWalletsWithKeys(user.id)).find(
    (candidate) => candidate.id === walletId,
  );
  if (!wallet) {
    throw new LnbitsGatewayError('Wallet does not belong to this account', 403);
  }
  return wallet;
};

const getWalletDetails = async (walletId, aadObjectId) => {
  const wallet = await requireOwnedWallet(walletId, aadObjectId);
  const details = await lnbitsRequest(`/api/v1/wallets/${encodeURIComponent(walletId)}`, {
    walletKey: wallet.inkey,
  });
  return sanitizeWallet({ ...wallet, ...details });
};

const walletBalanceSats = async (wallet) => {
  const details = await lnbitsRequest('/api/v1/wallet', { walletKey: wallet.inkey });
  return Number(details.balance || 0) / 1000;
};

const getWalletBalance = async (walletId, aadObjectId) =>
  walletBalanceSats(await requireOwnedWallet(walletId, aadObjectId));

// Deliberately tenant-wide: the team feed and the transaction log build their
// history from every teammate's wallet, so this read cannot be owner-only.
const listWalletPayments = async (walletId, limit = 100) => {
  const wallet = await getWalletWithKeys(walletId);
  const payments = await lnbitsRequest(`/api/v1/payments?limit=${limit}`, {
    walletKey: wallet.inkey,
  });
  if (!Array.isArray(payments)) {
    throw new LnbitsGatewayError('LNbits payments response is malformed');
  }
  return sanitizePaymentPage(payments, `wallet ${walletId}`);
};

const getInvoicePayment = async (walletId, invoiceId, aadObjectId) => {
  const wallet = await requireOwnedWallet(walletId, aadObjectId);
  return redactSensitive(
    await lnbitsRequest(`/api/v1/payments/${encodeURIComponent(invoiceId)}`, {
      walletKey: wallet.inkey,
    }),
  );
};

const getWalletPayLinks = async (walletId, aadObjectId) => {
  const wallet = await requireOwnedWallet(walletId, aadObjectId);
  return redactSensitive(
    await lnbitsRequest(
      `/lnurlp/api/v1/links?all_wallets=false&wallet=${encodeURIComponent(walletId)}`,
      { walletKey: wallet.inkey },
    ),
  );
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
  createInvoice(await requireOwnedWallet(walletId, aadObjectId), amount, memo);

const payInvoice = async (wallet, paymentRequest) => {
  const result = await lnbitsRequest('/api/v1/payments', {
    method: 'POST',
    walletKey: wallet.adminkey,
    body: { out: true, bolt11: paymentRequest },
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

const payOwnedInvoice = async ({ walletId, paymentRequest, aadObjectId }) =>
  payInvoice(await requireOwnedWallet(walletId, aadObjectId), paymentRequest);

// One wording for both the moment it happens and every later retry, so support
// sees the same string whichever way the user hits it.
const OUTCOME_UNKNOWN_MESSAGE =
  'This zap may have been paid but could not be recorded. Do not retry: ' +
  'contact support to confirm whether it went through.';

const createSendZap = ({
  findCallerForZap = findCaller,
  listWalletsForZap = listUserWalletsWithKeys,
  getBalanceForZap = walletBalanceSats,
  createInvoiceForZap = createInvoice,
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
    if (
      !USER_ID_PATTERN.test(recipientUserId || '') ||
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
      recipientUserId,
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
      if (recipientUserId === sender.id) {
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
        const senderWallets = await listWalletsForZap(sender.id);
        const senderWallet = senderWallets.find(
          (wallet) => String(wallet.name).trim().toLowerCase() === 'allowance',
        );
        if (!senderWallet) {
          throw new LnbitsGatewayError('Allowance wallet not found', 409);
        }

        const recipientWallets = await listWalletsForZap(recipientUserId);
        const recipientWallet = recipientWallets.find(
          (wallet) => String(wallet.name).trim().toLowerCase() === 'private',
        );
        if (!recipientWallet) {
          throw new LnbitsGatewayError('Recipient private wallet not found', 409);
        }

        const senderBalance = await getBalanceForZap(senderWallet);
        if (!Number.isFinite(senderBalance) || senderBalance < amount) {
          throw new LnbitsGatewayError('Insufficient allowance balance', 409);
        }

        const invoice = await createInvoiceForZap(
          recipientWallet,
          amount,
          memo,
        );
        // Recorded before the payment so a zap that dies mid-payment still
        // leaves the invoice id behind to reconcile against LNbits.
        await idempotencyStore.attachPayment({
          scope,
          requestHash,
          invoiceId: invoice.invoiceId,
        });
        paymentAttempted = true;
        const result = await payInvoiceForZap(
          senderWallet,
          invoice.paymentRequest,
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

const getNostrRewards = async (stallId) => {
  const rewards = await lnbitsRequest(
    `/nostrmarket/api/v1/stall/product/${encodeURIComponent(stallId)}`,
    { adminKey: true },
  );
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

const getAllPayments = async ({ limit = 1000, offset = 0, direction = 'desc' }) => {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sortby: 'time',
    direction: direction === 'asc' ? direction : 'desc',
  });
  const body = await lnbitsRequest(`/api/v1/payments/all/paginated?${params}`);
  const payments = Array.isArray(body)
    ? body
    : body?.data || body?.payments || body?.items;
  if (!Array.isArray(payments)) {
    throw new LnbitsGatewayError('LNbits payments response is malformed');
  }
  return sanitizePaymentPage(payments, 'the tenant-wide payments page');
};

const resetCachesForTests = () => {
  tokenCache = null;
  tokenRequest = null;
  walletCache.clear();
  walletIndex = null;
};

module.exports = {
  LnbitsGatewayError,
  assertCaller,
  createEnsureCaller,
  createInvoice,
  createSendZap,
  createOwnedInvoice,
  ensureCaller,
  getAllPayments,
  getInvoicePayment,
  getNostrRewards,
  getWalletBalance,
  getWalletDetails,
  getWalletPayLinks,
  listAllWallets,
  listRawUsers,
  listUserWallets,
  listUsers,
  listWalletPayments,
  maxZapAmountSats,
  payOwnedInvoice,
  resetCachesForTests,
  redactSensitive,
  sanitizePayment,
  sanitizeWallet,
  sanitizeBalanceMsat,
  sanitizeUser,
  sendZap,
};
