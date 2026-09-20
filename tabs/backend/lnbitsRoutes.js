const express = require('express');
const defaultService = require('./lnbitsGatewayService');
const {
  extractBearerToken: defaultExtractBearerToken,
  verifyMsalPayload: defaultVerifyMsalPayload,
} = require('./msalValidator');

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const INVOICE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const BOLT11_PATTERN = /^ln[a-z0-9]+$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

const validId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

// Only a real JSON number is an amount. `Number()` would turn `true` into 1 and
// `['5']` into 5, which are not integer amount inputs.
const parseAmount = (value, maxSats) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return null;
  }
  return value > 0 && value <= maxSats ? value : null;
};

// Pagination is validated, never clamped: a caller-supplied `10.5` or `1e3` is a
// bad request, not something to silently round into an LNbits query.
const parseBoundedInt = (value, { fallback, min, max }) => {
  if (value === undefined) {
    return fallback;
  }
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\+?\d+$/.test(value)
        ? Number.parseInt(value, 10)
        : NaN;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
};

// A body key the route does not read is a key the caller believed it could set.
// `aadObjectId` is the one that matters: authorization is derived from the
// verified token and never from the body, and refusing the key says so out loud
// instead of accepting the request and quietly ignoring it. The portal client
// sends exactly these fields.
const INVOICE_BODY_KEYS = new Set(['amount', 'memo']);
const PAYMENT_BODY_KEYS = new Set(['paymentRequest']);
const ZAP_BODY_KEYS = new Set(['recipientUserId', 'amount', 'memo']);

const hasOnlyKeys = (body, allowed) =>
  typeof body === 'object' &&
  body !== null &&
  !Array.isArray(body) &&
  Object.keys(body).every((key) => allowed.has(key));

const parseMemo = (value) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 500
    ? value.trim()
    : null;

const createLnbitsRouter = ({
  service = defaultService,
  extractBearerToken = defaultExtractBearerToken,
  verifyMsalPayload = defaultVerifyMsalPayload,
} = {}) => {
  const router = express.Router();

  router.use(async (req, res, next) => {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'missing credentials' });
      return;
    }
    try {
      const claims = await verifyMsalPayload(token);
      if (!claims || typeof claims.oid !== 'string' || claims.oid.length === 0) {
        throw new Error('token is missing the oid claim');
      }
      // Trimmed: a whitespace-only claim would otherwise count as present and
      // be persisted as the LNbits email or an AccountName avatar URL.
      const claimString = (value) =>
        typeof value === 'string' ? value.trim() : '';
      // Profile details for first-run provisioning come from the verified
      // token, never from the request body, so they cannot be forged.
      req.auth = {
        oid: claims.oid,
        roles: claims.roles || [],
        name: claimString(claims.name),
        email:
          claimString(claims.email) || claimString(claims.preferred_username),
        userPrincipalName:
          claimString(claims.upn) || claimString(claims.preferred_username),
      };
      next();
    } catch (error) {
      console.error('LNbits gateway token validation failed:', error.message);
      res.status(401).json({ error: 'invalid token' });
    }
  });

  // A verified caller who has never used the bot has no LNbits account yet;
  // provision one here instead of failing the whole tab with a 403.
  //
  // TODO: who may self-provision is an open product decision (Ben is settling
  // it separately). Today any caller with a valid tenant token gets an account
  // and an opening allowance on first request; a narrower gate (an Entra group,
  // an explicit invite) would go here. Deliberately unchanged in this PR.
  router.use(async (req, _res, next) => {
    try {
      const { user } = await service.ensureCaller({
        aadObjectId: req.auth.oid,
        displayName: req.auth.name,
        email: req.auth.email,
        userPrincipalName: req.auth.userPrincipalName,
      });
      // Remembered so a listing of the caller's *own* wallets can finish an
      // interrupted provisioning (see repairCallerWallets). Other users'
      // listings are read-only, as before.
      req.auth.lnbitsUserId = typeof user?.id === 'string' ? user.id : '';
      next();
    } catch (error) {
      next(error);
    }
  });

  // Directory, feed, leaderboard, rewards and per-wallet payment history are
  // intentionally tenant-visible. Every other wallet route resolves the wallet
  // through the caller's own LNbits user, so a wallet id alone grants nothing.

  const asyncRoute = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };

  router.get('/users', asyncRoute(async (_req, res) => {
    res.json(await service.listUsers());
  }));

  router.get('/users/:userId/wallets', asyncRoute(async (req, res) => {
    if (!validId(req.params.userId)) {
      res.status(400).json({ error: 'invalid user id' });
      return;
    }
    const wallets = await service.listUserWallets(req.params.userId);
    res.json(
      req.params.userId === req.auth.lnbitsUserId
        ? await service.repairCallerWallets(req.params.userId, wallets)
        : wallets,
    );
  }));

  router.get('/wallets', asyncRoute(async (_req, res) => {
    res.json(await service.listAllWallets());
  }));

  router.get('/wallets/:walletId', asyncRoute(async (req, res) => {
    if (!validId(req.params.walletId)) {
      res.status(400).json({ error: 'invalid wallet id' });
      return;
    }
    res.json(await service.getWalletDetails(req.params.walletId, req.auth.oid));
  }));

  router.get('/wallets/:walletId/balance', asyncRoute(async (req, res) => {
    if (!validId(req.params.walletId)) {
      res.status(400).json({ error: 'invalid wallet id' });
      return;
    }
    res.json({
      balance: await service.getWalletBalance(req.params.walletId, req.auth.oid),
    });
  }));

  router.get('/wallets/:walletId/payments', asyncRoute(async (req, res) => {
    const limit = parseBoundedInt(req.query.limit, {
      fallback: 100,
      min: 1,
      max: 1000,
    });
    if (!validId(req.params.walletId) || limit === null) {
      res.status(400).json({ error: 'invalid payment history request' });
      return;
    }
    res.json(await service.listWalletPayments(req.params.walletId, limit));
  }));

  router.get('/wallets/:walletId/payments/:invoiceId', asyncRoute(async (req, res) => {
    if (
      !validId(req.params.walletId) ||
      !INVOICE_PATTERN.test(req.params.invoiceId)
    ) {
      res.status(400).json({ error: 'invalid wallet or invoice id' });
      return;
    }
    res.json(
      await service.getInvoicePayment(
        req.params.walletId,
        req.params.invoiceId,
        req.auth.oid,
      ),
    );
  }));

  router.get('/wallets/:walletId/paylinks', asyncRoute(async (req, res) => {
    if (!validId(req.params.walletId)) {
      res.status(400).json({ error: 'invalid wallet id' });
      return;
    }
    res.json(await service.getWalletPayLinks(req.params.walletId, req.auth.oid));
  }));

  router.post('/wallets/:walletId/invoices', asyncRoute(async (req, res) => {
    const amount = parseAmount(req.body?.amount, service.maxZapAmountSats());
    const memo = parseMemo(req.body?.memo);
    if (
      !hasOnlyKeys(req.body, INVOICE_BODY_KEYS) ||
      !validId(req.params.walletId) ||
      amount === null ||
      memo === null
    ) {
      res.status(400).json({ error: 'invalid invoice request' });
      return;
    }
    const invoice = await service.createOwnedInvoice({
      walletId: req.params.walletId,
      amount,
      memo,
      aadObjectId: req.auth.oid,
    });
    res.status(201).json(invoice);
  }));

  router.post('/wallets/:walletId/payments', asyncRoute(async (req, res) => {
    const paymentRequest = req.body?.paymentRequest;
    if (
      !hasOnlyKeys(req.body, PAYMENT_BODY_KEYS) ||
      !validId(req.params.walletId) ||
      typeof paymentRequest !== 'string' ||
      paymentRequest.length > 4096 ||
      !BOLT11_PATTERN.test(paymentRequest)
    ) {
      res.status(400).json({ error: 'invalid payment request' });
      return;
    }
    res.json(
      await service.payOwnedInvoice({
        walletId: req.params.walletId,
        paymentRequest,
        aadObjectId: req.auth.oid,
      }),
    );
  }));

  router.post('/zaps', asyncRoute(async (req, res) => {
    const amount = parseAmount(req.body?.amount, service.maxZapAmountSats());
    const memo = parseMemo(req.body?.memo);
    const idempotencyKey = req.get('Idempotency-Key');
    if (
      !hasOnlyKeys(req.body, ZAP_BODY_KEYS) ||
      !validId(req.body?.recipientUserId) ||
      amount === null ||
      memo === null ||
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey || '')
    ) {
      res.status(400).json({ error: 'invalid zap request' });
      return;
    }
    res.json(
      await service.sendZap({
        recipientUserId: req.body.recipientUserId,
        amount,
        memo,
        aadObjectId: req.auth.oid,
        idempotencyKey,
      }),
    );
  }));

  router.get('/rewards/:stallId', asyncRoute(async (req, res) => {
    if (!validId(req.params.stallId)) {
      res.status(400).json({ error: 'invalid stall id' });
      return;
    }
    res.json(await service.getNostrRewards(req.params.stallId));
  }));

  router.get('/payments', asyncRoute(async (req, res) => {
    const limit = parseBoundedInt(req.query.limit, {
      fallback: 1000,
      min: 1,
      max: 10000,
    });
    const offset = parseBoundedInt(req.query.offset, {
      fallback: 0,
      min: 0,
      max: 1_000_000,
    });
    if (limit === null || offset === null) {
      res.status(400).json({ error: 'invalid pagination request' });
      return;
    }
    res.json(
      await service.getAllPayments({
        limit,
        offset,
        sortby: req.query.sortby,
        direction: req.query.direction,
      }),
    );
  }));

  router.use((error, req, res, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 502;
    // Name the route that failed, so a 502 in the log can be tied to a request
    // without the masked body. The query string is dropped rather than logged.
    // The path is request-controlled, so it is passed as an argument and never
    // as the format string, which console would expand %s/%j from.
    const route = `${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]}`;
    console.error('LNbits gateway request failed:', route, error.message);
    res.status(status).json({
      error:
        status >= 500 && !error.expose
          ? 'LNbits service is unavailable'
          : error.message,
    });
  });

  return router;
};

module.exports = createLnbitsRouter();
module.exports.createLnbitsRouter = createLnbitsRouter;
module.exports.parseAmount = parseAmount;
