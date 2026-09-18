const {
  getLnbitsToken,
  requireLnbitsConfig,
} = require('./lnbitsAdmin');
const {
  findUniqueUserByAadObjectId,
  findUsersByAadObjectId,
  parseExtra,
} = require('./lnbitsUserDirectory');
const {
  createZapIdempotencyStore,
} = require('./lnbitsZapIdempotencyStore');

const TOKEN_CACHE_MS = 5 * 60 * 1000;
const WALLET_CACHE_MS = 30 * 1000;
const SENSITIVE_FIELD = /(adminkey|inkey|admin.?key|invoice.?key|password|preimage|secret|token)/i;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;
const PRIVATE_WALLET_NAME = 'Private';
const ALLOWANCE_WALLET_NAME = 'Allowance';
// Surfaced verbatim by the tab (src/services/lnbitsServiceLocal.ts forwards the
// gateway's `error` field), so it has to read as user-facing copy.
const PROVISIONING_FAILED_MESSAGE =
  'We could not create your Zaplie wallet yet — try again';
// Avatars come from the tenant's own SharePoint host, so there is no sane
// default: the bot hardcodes one tenant (src/services/userService.ts), which
// would fabricate a URL for the wrong organisation everywhere else. When
// PROFILE_PHOTO_HOST is unset the avatar is simply omitted and the tab falls
// back to its initials placeholder.
const profilePhotoUrl = (userPrincipalName) => {
  const host = String(process.env.PROFILE_PHOTO_HOST || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!host || !userPrincipalName) {
    return '';
  }
  return `https://${host}/_layouts/15/userphoto.aspx?AccountName=${encodeURIComponent(
    userPrincipalName,
  )}`;
};

let tokenCache = null;
const walletCache = new Map();

class LnbitsGatewayError extends Error {
  constructor(message, status = 502, { expose = false } = {}) {
    super(message);
    this.name = 'LnbitsGatewayError';
    this.status = status;
    // 5xx messages are masked by the router unless they are deliberate,
    // already-safe copy for the signed-in user.
    this.expose = expose;
  }
}

const requireGatewayConfig = () => ({
  ...requireLnbitsConfig(),
  adminKey: process.env.LNBITS_ADMINKEY || '',
});

const maxZapAmountSats = () => {
  const configured = process.env.REWARDS_MAX_AMOUNT_SATS;
  if (configured === undefined || configured === '') {
    return 1_000_000;
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LnbitsGatewayError(
      'REWARDS_MAX_AMOUNT_SATS must be a positive integer',
      503,
    );
  }
  return value;
};

const getAccessToken = async (config) => {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) {
    return tokenCache.value;
  }
  const value = await getLnbitsToken(config);
  tokenCache = { value, expiresAt: now + TOKEN_CACHE_MS };
  return value;
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

  const response = await fetch(`${config.nodeUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (!response.ok) {
    if (!options.walletKey && !options.adminKey && response.status === 401) {
      tokenCache = null;
    }
    throw new LnbitsGatewayError(
      `LNbits request failed with status ${response.status}`,
    );
  }
  if (options.expectJson === false) {
    return null;
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
  // extra.display_name is what a provisioned account actually carries (LNbits
  // itself leaves username/name empty), so it has to be read before falling
  // back to the opaque LNbits id.
  let displayName =
    user.username || user.name || extra.display_name || user.email || user.id;
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

const sanitizeWallet = (wallet) => ({
  id: wallet.id,
  name: wallet.name,
  user: wallet.user,
  balance_msat: Number(wallet.balance_msat || 0),
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

const getWalletWithKeys = async (walletId) => {
  const cached = walletCache.get(walletId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.wallet;
  }
  walletCache.delete(walletId);

  for (const user of await listRawUsers()) {
    const wallets = await listUserWalletsWithKeys(user.id);
    const match = wallets.find((wallet) => wallet.id === walletId);
    if (match) {
      return match;
    }
  }
  throw new LnbitsGatewayError('Wallet not found', 404);
};

const listAllWallets = async () => {
  const wallets = [];
  for (const user of await listRawUsers()) {
    wallets.push(...(await listUserWallets(user.id)));
  }
  return wallets;
};

const findLinkedUser = async (aadObjectId) =>
  findUniqueUserByAadObjectId(await listRawUsers(), aadObjectId);

const findCaller = async (aadObjectId) => {
  const user = await findLinkedUser(aadObjectId);
  if (!user) {
    throw new LnbitsGatewayError('No LNbits user is linked to this account', 403);
  }
  return user;
};

// Wallet names are matched case-insensitively because sendZap already treats
// them that way, and a hand-renamed wallet must not trigger a duplicate.
const walletNamed = (wallets, name) =>
  wallets.find(
    (wallet) => String(wallet.name).trim().toLowerCase() === name.toLowerCase(),
  ) || null;

// Two different situations, deliberately kept apart:
//
// - ABSENT: no opening allowance is configured for this deployment. First-touch
//   portal provisioning still has to succeed, so the account is created
//   unfunded and the skip is recorded on the result. This is the divergence
//   from the weekly-allowance path, which simply has nothing to top up.
// - MALFORMED: a value is configured but cannot be honoured. That is an
//   operator mistake, not a deployment choice, so it is flagged as a
//   configuration error and logged as one.
//
// The "positive integer" rule is the same one the rest of the backend applies
// to sat amounts (rewardAmounts.js maxRewardSats, maxZapAmountSats above), so
// '500abc' is malformed here exactly as it is there — unlike the bot's
// parseInt, which would silently read it as 500.
const initialAllowance = () => {
  const configured = process.env.LNBITS_INITIAL_ALLOWANCE;
  if (configured === undefined || String(configured).trim() === '') {
    return {
      amount: 0,
      skipReason: 'LNBITS_INITIAL_ALLOWANCE is not set',
      configurationError: false,
    };
  }
  const amount = Number(String(configured).trim());
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return {
      amount: 0,
      skipReason: `LNBITS_INITIAL_ALLOWANCE must be a positive integer (${configured})`,
      configurationError: true,
    };
  }
  return { amount, skipReason: null, configurationError: false };
};

const createLnbitsUser = async ({
  aadObjectId,
  displayName,
  email,
  userPrincipalName,
}) => {
  const profileImg = profilePhotoUrl(userPrincipalName);
  const user = await lnbitsRequest('/users/api/v1/user', {
    method: 'POST',
    body: {
      email: email || undefined,
      // The Entra object id lives in external_id, exactly as the bot writes it,
      // so lnbitsUserDirectory links the account either way it is queried.
      external_id: aadObjectId,
      extra: {
        // display_name/picture are what the bot reads back
        // (src/services/lnbitsService.ts toUser); profileImg/type/aadObjectId
        // are what the tab reads back (sanitizeUser above). Writing both keeps
        // bot- and portal-provisioned accounts interchangeable.
        display_name: displayName,
        picture: profileImg,
        profileImg,
        aadObjectId,
        email: email || '',
        type: 'Teammate',
        userType: 'teammate',
      },
    },
  });
  if (!user || typeof user.id !== 'string' || user.id.length === 0) {
    throw new LnbitsGatewayError('LNbits user creation response is malformed');
  }
  return user;
};

const deleteLnbitsUser = async (userId) => {
  await lnbitsRequest(`/users/api/v1/user/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    // The User Manager delete returns 200 with no body on some LNbits builds.
    expectJson: false,
  });
};

// The in-flight map that dedupes concurrent first requests is per-process, so
// two portal instances behind the same load balancer can both miss the
// directory lookup and create an LNbits user for one Entra oid. That leaves the
// account permanently unusable: findUniqueUserByAadObjectId throws on every
// later request. Re-read the directory immediately after creating, and collapse
// a lost race back to a single row.
const resolveDuplicateLnbitsUser = async (aadObjectId, created) => {
  const linked = findUsersByAadObjectId(await listRawUsers(), aadObjectId);
  // Anything else carrying this oid is another instance's account. Not finding
  // our own row back (a lagging directory read) is not a reason to keep both.
  const others = linked.filter((user) => user.id !== created.id);
  if (others.length === 0) {
    return created;
  }
  const survivor = others[0];
  console.warn(
    `Zaplie provisioning: ${others.length + 1} LNbits users are linked to ` +
      `${aadObjectId}; keeping ${survivor.id} and removing the duplicate ` +
      `${created.id}`,
  );
  try {
    await deleteLnbitsUser(created.id);
  } catch (error) {
    console.error(
      `Zaplie provisioning: could not delete duplicate LNbits user ${created.id} for ` +
        `${aadObjectId} (${error.message}). Every request for this account will fail ` +
        'until the duplicate is removed by hand.',
    );
  }
  return survivor;
};

const createUserWallet = async (userId, name) => {
  // POST /api/v1/wallet creates under the caller, so the per-user admin route
  // is required to own the wallet from the target account.
  const wallet = await lnbitsRequest(
    `/users/api/v1/user/${encodeURIComponent(userId)}/wallet`,
    { method: 'POST', body: { name } },
  );
  if (!wallet || typeof wallet.id !== 'string' || wallet.id.length === 0) {
    throw new LnbitsGatewayError('LNbits wallet creation response is malformed');
  }
  cacheWallet(wallet);
  return wallet;
};

// LNbits >= 1.0 dropped /topup in favour of PUT /users/api/v1/balance, which is
// the same admin-credit call the bot makes (lnbitsService.ts topUpWallet). It
// authenticates with the superuser token the gateway already holds, so no host
// wallet key is involved.
const creditWallet = async (walletId, amount) => {
  await lnbitsRequest('/users/api/v1/balance', {
    method: 'PUT',
    body: { id: walletId, amount },
  });
};

const ensureProvisionedWallets = async (userId) => {
  const existing = await listUserWalletsWithKeys(userId);
  const knownAllowance = walletNamed(existing, ALLOWANCE_WALLET_NAME);
  const privateWallet =
    walletNamed(existing, PRIVATE_WALLET_NAME) ||
    (await createUserWallet(userId, PRIVATE_WALLET_NAME));
  const allowanceWallet =
    knownAllowance || (await createUserWallet(userId, ALLOWANCE_WALLET_NAME));
  return {
    privateWallet,
    allowanceWallet,
    // Only a wallet we just created may be funded: topping up an existing one
    // would hand a refill to anyone who spends down to zero.
    allowanceCreated: knownAllowance === null,
  };
};

const fundAllowanceWallet = async (walletId) => {
  const { amount, skipReason, configurationError } = initialAllowance();
  if (amount === 0) {
    const message =
      `Zaplie provisioning: allowance wallet ${walletId} left unfunded ` +
      `(${skipReason})`;
    // A misconfigured value is an operator error worth an error-level line; an
    // absent one is a deliberate deployment choice and only warrants a warning.
    if (configurationError) {
      console.error(message);
    } else {
      console.warn(message);
    }
    return { funded: false, amount: 0, skipReason, configurationError };
  }
  try {
    await creditWallet(walletId, amount);
    return {
      funded: true,
      amount,
      skipReason: null,
      configurationError: false,
    };
  } catch (error) {
    // Funding is deliberately not fatal here: this is first-touch provisioning,
    // and refusing to serve a brand-new user with a 503 because a funding env
    // is missing or LNbits rejected the credit would lock them out of the
    // portal entirely. The account works without its opening balance, so the
    // failure is logged and flagged on the result instead.
    const reason = `initial allowance top-up failed: ${error.message}`;
    console.error(`Zaplie provisioning: ${reason}`);
    return {
      funded: false,
      amount,
      skipReason: reason,
      configurationError: false,
    };
  }
};

// The wallets were cached at creation time, before the allowance credit landed,
// so drop this account's directory entries and let the next read repopulate.
const invalidateUserDirectory = (userId) => {
  for (const [walletId, entry] of walletCache) {
    if (entry.wallet?.user === userId) {
      walletCache.delete(walletId);
    }
  }
};

// The Entra object id is a GUID and must never reach the UI: it would become
// this account's name in the directory, on the leaderboard and on every zap.
// A caller whose token carries no name claim falls back to the email local
// part, and a caller with neither to a readable label kept distinguishable by a
// short suffix.
const callerDisplayName = (aadObjectId, profile = {}) => {
  const claimed = String(profile.displayName || '').trim();
  if (claimed) {
    return claimed;
  }
  const localPart = String(profile.email || profile.userPrincipalName || '')
    .split('@')[0]
    .trim();
  if (localPart) {
    return localPart;
  }
  return `Teammate ${String(aadObjectId).slice(-4)}`;
};

// Provisioning can be interrupted between "LNbits user created" and "both
// wallets created", and the caller gate deliberately short-circuits for an
// already linked user, so nothing would ever finish the job. Verifying the two
// wallets on the caller gate would cost an extra LNbits listing on *every*
// request, so the repair hangs off the one moment the gap is actually observed
// for free: the caller's own wallet listing (GET /users/:id/wallets, the first
// thing the tab asks for) coming back without both wallets. A healthy account
// pays nothing — the listing already happened, and the check is in memory.
const repairCallerWallets = async (userId, wallets) => {
  const list = Array.isArray(wallets) ? wallets : [];
  const missing = [PRIVATE_WALLET_NAME, ALLOWANCE_WALLET_NAME].filter(
    (name) => walletNamed(list, name) === null,
  );
  if (missing.length === 0) {
    return list;
  }

  try {
    console.warn(
      `Zaplie provisioning: repairing half-provisioned LNbits user ${userId} ` +
        `(missing ${missing.join(', ')})`,
    );
    const repaired = await ensureProvisionedWallets(userId);
    if (repaired.allowanceCreated) {
      // This finishes an interrupted provisioning rather than refilling an
      // account: a wallet that already existed is never topped up, so nobody
      // can farm an allowance by spending down to zero.
      await fundAllowanceWallet(repaired.allowanceWallet.id);
      invalidateUserDirectory(userId);
    }
    const known = new Set(list.map((wallet) => wallet.id));
    return [
      ...list,
      ...[repaired.privateWallet, repaired.allowanceWallet]
        .filter((wallet) => !known.has(wallet.id))
        .map(sanitizeWallet),
    ];
  } catch (error) {
    // A failed repair must not blank the wallet page: whatever the account does
    // have is still returned, and the next request tries again.
    console.error(
      `Zaplie provisioning: repair of LNbits user ${userId} failed: ${error.message}`,
    );
    return list;
  }
};

const createEnsureCaller = ({
  findLinkedUserForCaller = findLinkedUser,
  createUserForCaller = createLnbitsUser,
  ensureWalletsForCaller = ensureProvisionedWallets,
  fundAllowanceForCaller = fundAllowanceWallet,
  invalidateForCaller = invalidateUserDirectory,
  resolveDuplicateForCaller = resolveDuplicateLnbitsUser,
} = {}) => {
  const inFlight = new Map();

  const provision = async (aadObjectId, profile) => {
    // Re-check inside the critical section: a request that queued behind the
    // directory lookup must not create a second LNbits account.
    const linked = await findLinkedUserForCaller(aadObjectId);
    if (linked) {
      return { user: linked, provisioned: false, funding: null };
    }

    const created = await createUserForCaller({
      aadObjectId,
      displayName: callerDisplayName(aadObjectId, profile),
      email: profile.email || '',
      userPrincipalName: profile.userPrincipalName || '',
    });

    const user = await resolveDuplicateForCaller(aadObjectId, created);
    if (user.id !== created.id) {
      // Another instance won the race; its account is the survivor and it is
      // provisioning its own wallets, so nothing more is owed here.
      return { user, provisioned: false, funding: null };
    }

    const wallets = await ensureWalletsForCaller(user.id);
    const funding = wallets.allowanceCreated
      ? await fundAllowanceForCaller(wallets.allowanceWallet.id)
      : {
          funded: false,
          amount: 0,
          skipReason: 'allowance wallet already existed',
          configurationError: false,
        };
    await invalidateForCaller(user.id);

    console.log(
      `Zaplie provisioning: created LNbits user ${user.id} for ${aadObjectId} ` +
        `(funded: ${funding.funded}${funding.skipReason ? `, ${funding.skipReason}` : ''})`,
    );
    return { user, provisioned: true, wallets, funding };
  };

  return async (input) => {
    const profile = typeof input === 'string' ? { aadObjectId: input } : input || {};
    const aadObjectId = profile.aadObjectId;
    if (typeof aadObjectId !== 'string' || aadObjectId.length === 0) {
      // Only a verified token reaches this point; an absent oid means the
      // caller was never authenticated, so nothing is ever provisioned.
      throw new LnbitsGatewayError(
        'No LNbits user is linked to this account',
        403,
      );
    }

    const existing = await findLinkedUserForCaller(aadObjectId);
    if (existing) {
      return { user: existing, provisioned: false, funding: null };
    }

    let operation = inFlight.get(aadObjectId);
    if (!operation) {
      operation = provision(aadObjectId, profile);
      inFlight.set(aadObjectId, operation);
      const release = () => {
        if (inFlight.get(aadObjectId) === operation) {
          inFlight.delete(aadObjectId);
        }
      };
      operation.then(release, release);
    }

    try {
      return await operation;
    } catch (error) {
      if (error instanceof LnbitsGatewayError && error.status === 403) {
        throw error;
      }
      console.error('Zaplie provisioning failed:', error.message);
      throw new LnbitsGatewayError(PROVISIONING_FAILED_MESSAGE, 503, {
        expose: true,
      });
    }
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

const getWalletDetails = async (walletId) => {
  const wallet = await getWalletWithKeys(walletId);
  const details = await lnbitsRequest(`/api/v1/wallets/${encodeURIComponent(walletId)}`, {
    walletKey: wallet.inkey,
  });
  return sanitizeWallet({ ...wallet, ...details });
};

const getWalletBalance = async (walletId) => {
  const wallet = await getWalletWithKeys(walletId);
  const details = await lnbitsRequest('/api/v1/wallet', { walletKey: wallet.inkey });
  return Number(details.balance || 0) / 1000;
};

const listWalletPayments = async (walletId, limit = 100) => {
  const wallet = await getWalletWithKeys(walletId);
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const payments = await lnbitsRequest(`/api/v1/payments?limit=${safeLimit}`, {
    walletKey: wallet.inkey,
  });
  if (!Array.isArray(payments)) {
    throw new LnbitsGatewayError('LNbits payments response is malformed');
  }
  return payments.map(sanitizePayment);
};

const getInvoicePayment = async (walletId, invoiceId) => {
  const wallet = await getWalletWithKeys(walletId);
  return redactSensitive(
    await lnbitsRequest(`/api/v1/payments/${encodeURIComponent(invoiceId)}`, {
      walletKey: wallet.inkey,
    }),
  );
};

const getWalletPayLinks = async (walletId) => {
  const wallet = await getWalletWithKeys(walletId);
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
  const invoiceId = result.checking_id || result.payment_hash;
  if (
    typeof paymentRequest !== 'string' ||
    paymentRequest.length === 0 ||
    paymentRequest.length > 4096 ||
    typeof invoiceId !== 'string' ||
    invoiceId.length === 0 ||
    invoiceId.length > 256
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

const createSendZap = ({
  findCallerForZap = findCaller,
  listWalletsForZap = listUserWalletsWithKeys,
  getBalanceForZap = getWalletBalance,
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

      let paymentAttempted = false;
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

        const senderBalance = await getBalanceForZap(senderWallet.id);
        if (!Number.isFinite(senderBalance) || senderBalance < amount) {
          throw new LnbitsGatewayError('Insufficient allowance balance', 409);
        }

        const invoice = await createInvoiceForZap(
          recipientWallet,
          amount,
          memo,
        );
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
        }
        return result;
      } catch (error) {
        try {
          if (paymentAttempted) {
            await idempotencyStore.fail({ scope, requestHash });
          } else {
            // No payment was attempted, so the key is safe to retry.
            await idempotencyStore.release({ scope, requestHash });
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
    limit: String(Math.min(Math.max(Number(limit) || 1000, 1), 10000)),
    offset: String(Math.max(Number(offset) || 0, 0)),
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
  return payments.map(sanitizePayment);
};

const resetCachesForTests = () => {
  tokenCache = null;
  walletCache.clear();
};

module.exports = {
  LnbitsGatewayError,
  PROVISIONING_FAILED_MESSAGE,
  callerDisplayName,
  createEnsureCaller,
  createInvoice,
  createLnbitsUser,
  createSendZap,
  ensureCaller,
  ensureProvisionedWallets,
  fundAllowanceWallet,
  initialAllowance,
  createOwnedInvoice,
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
  repairCallerWallets,
  resetCachesForTests,
  redactSensitive,
  sanitizePayment,
  sanitizeWallet,
  sendZap,
};
