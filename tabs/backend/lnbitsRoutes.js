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

const parseAmount = (value) => {
  const amount = Number(value);
  const configuredMax = Number(process.env.REWARDS_MAX_AMOUNT_SATS);
  const max = Number.isSafeInteger(configuredMax) && configuredMax > 0
    ? configuredMax
    : 1_000_000;
  return Number.isSafeInteger(amount) && amount > 0 && amount <= max
    ? amount
    : null;
};

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
      req.auth = { oid: claims.oid, roles: claims.roles || [] };
      next();
    } catch (error) {
      console.error('LNbits gateway token validation failed:', error.message);
      res.status(401).json({ error: 'invalid token' });
    }
  });

  router.use(async (req, _res, next) => {
    try {
      await service.assertCaller(req.auth.oid);
      next();
    } catch (error) {
      next(error);
    }
  });

  // Directory, team feed, leaderboard, and rewards are intentionally visible
  // to any linked Zaplie user in this tenant. Wallet mutations below additionally
  // enforce ownership in lnbitsGatewayService.

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
    res.json(await service.listUserWallets(req.params.userId));
  }));

  router.get('/wallets', asyncRoute(async (_req, res) => {
    res.json(await service.listAllWallets());
  }));

  router.get('/wallets/:walletId', asyncRoute(async (req, res) => {
    if (!validId(req.params.walletId)) {
      res.status(400).json({ error: 'invalid wallet id' });
      return;
    }
    res.json(await service.getWalletDetails(req.params.walletId));
  }));

  router.get('/wallets/:walletId/balance', asyncRoute(async (req, res) => {
    if (!validId(req.params.walletId)) {
      res.status(400).json({ error: 'invalid wallet id' });
      return;
    }
    res.json({ balance: await service.getWalletBalance(req.params.walletId) });
  }));

  router.get('/wallets/:walletId/payments', asyncRoute(async (req, res) => {
    if (!validId(req.params.walletId)) {
      res.status(400).json({ error: 'invalid wallet id' });
      return;
    }
    res.json(await service.listWalletPayments(req.params.walletId, req.query.limit));
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
      await service.getInvoicePayment(req.params.walletId, req.params.invoiceId),
    );
  }));

  router.get('/wallets/:walletId/paylinks', asyncRoute(async (req, res) => {
    if (!validId(req.params.walletId)) {
      res.status(400).json({ error: 'invalid wallet id' });
      return;
    }
    res.json(await service.getWalletPayLinks(req.params.walletId));
  }));

  router.post('/wallets/:walletId/invoices', asyncRoute(async (req, res) => {
    const amount = parseAmount(req.body?.amount);
    const memo = parseMemo(req.body?.memo);
    if (!validId(req.params.walletId) || amount === null || memo === null) {
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
    const amount = parseAmount(req.body?.amount);
    const memo = parseMemo(req.body?.memo);
    const idempotencyKey = req.get('Idempotency-Key');
    if (
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
    res.json(
      await service.getAllPayments({
        limit: req.query.limit,
        offset: req.query.offset,
        sortby: req.query.sortby,
        direction: req.query.direction,
      }),
    );
  }));

  router.use((error, _req, res, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 502;
    console.error('LNbits gateway request failed:', error.message);
    res.status(status).json({
      error: status >= 500 ? 'LNbits service is unavailable' : error.message,
    });
  });

  return router;
};

module.exports = createLnbitsRouter();
module.exports.createLnbitsRouter = createLnbitsRouter;
module.exports.parseAmount = parseAmount;
