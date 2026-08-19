const {
  getLnbitsToken,
  requireLnbitsConfig,
} = require('./lnbitsAdmin');
const {
  findUniqueUserByAadObjectId,
  parseExtra,
} = require('./lnbitsUserDirectory');

const TOKEN_CACHE_MS = 5 * 60 * 1000;
const WALLET_CACHE_MS = 30 * 1000;
const SENSITIVE_FIELD = /(adminkey|inkey|admin.?key|invoice.?key|password|preimage|secret|token)/i;

let tokenCache = null;
const walletCache = new Map();

class LnbitsGatewayError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'LnbitsGatewayError';
    this.status = status;
  }
}

const requireGatewayConfig = () => ({
  ...requireLnbitsConfig(),
  adminKey: process.env.LNBITS_ADMINKEY || '',
});

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
  let displayName = user.username || user.name || user.id;
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

const sanitizePayment = (payment) => ({
  checking_id: payment.checking_id || payment.payment_hash || payment.id || '',
  payment_hash: payment.payment_hash,
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
  if (!result.payment_request) {
    throw new LnbitsGatewayError('LNbits did not return an invoice');
  }
  return result.payment_request;
};

const createOwnedInvoice = async ({ walletId, amount, memo, aadObjectId }) =>
  createInvoice(await requireOwnedWallet(walletId, aadObjectId), amount, memo);

const payInvoice = async (wallet, paymentRequest) => {
  const result = await lnbitsRequest('/api/v1/payments', {
    method: 'POST',
    walletKey: wallet.adminkey,
    body: { out: true, bolt11: paymentRequest },
  });
  const paymentId = result.payment_hash || result.checking_id;
  if (typeof paymentId !== 'string' || paymentId.length === 0) {
    throw new LnbitsGatewayError('LNbits did not return a payment identifier');
  }
  return {
    payment_hash: paymentId,
    checking_id: result.checking_id || result.payment_hash,
  };
};

const payOwnedInvoice = async ({ walletId, paymentRequest, aadObjectId }) =>
  payInvoice(await requireOwnedWallet(walletId, aadObjectId), paymentRequest);

const sendZap = async ({ recipientUserId, amount, memo, aadObjectId }) => {
  const sender = await findCaller(aadObjectId);
  const senderWallets = await listUserWalletsWithKeys(sender.id);
  const senderWallet = senderWallets.find((wallet) =>
    String(wallet.name).toLowerCase().includes('allowance'),
  );
  if (!senderWallet) {
    throw new LnbitsGatewayError('Allowance wallet not found', 409);
  }

  const recipientWallets = await listUserWalletsWithKeys(recipientUserId);
  const recipientWallet = recipientWallets.find((wallet) =>
    String(wallet.name).toLowerCase().includes('private'),
  );
  if (!recipientWallet) {
    throw new LnbitsGatewayError('Recipient private wallet not found', 409);
  }

  const senderBalance = await getWalletBalance(senderWallet.id);
  if (senderBalance < amount) {
    throw new LnbitsGatewayError('Insufficient allowance balance', 409);
  }

  const paymentRequest = await createInvoice(recipientWallet, amount, memo);
  return payInvoice(senderWallet, paymentRequest);
};

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
  assertCaller,
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
  payOwnedInvoice,
  resetCachesForTests,
  redactSensitive,
  sanitizePayment,
  sanitizeWallet,
  sendZap,
};
