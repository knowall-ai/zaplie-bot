// filepath: tabs/backend/directoryRoutes.js
// The people directory over HTTP. Three audiences, three credentials:
//
//   /me/*        the signed-in person (verified MSAL token): see their own
//                Allowance balance, register where they receive zaps.
//   /admin/*     Zaplie.Admin: see who is set up, link an Allowance wallet by
//                its NWC connection string and Lightning address.
//   /internal/*  the bot (shared TAB_BACKEND_TOKEN): resolve and provision
//                people, pay a zap or a reward, read balances and zaps.
//
// No credential ever leaves this server: every person goes out through
// toPublicPerson. The bot holds no wallet access of its own; it asks this
// backend to pay, and payments only ever go to a directory member, resolved
// here from their Entra id (an invoice or address from a client is never
// paid).
const express = require('express');
const authMiddleware = require('./authMiddleware');
const { requireAdmin } = require('./adminAuth');
const { requireMsalOid: defaultRequireMsalOid } = require('./requireMsalOid');
const { walletDirectory: defaultDirectory } = require('./walletDirectory');
const { normalizeOid, toPublicPerson } = require('./peopleStore');
const gateway = require('./lnbitsGatewayService');
const { zapRecords: defaultZapRecords } = require('./zapRecordStore');

const RECEIVE_BODY_KEYS = new Set(['lightningAddress']);
const LINK_BODY_KEYS = new Set(['nwcUrl', 'lightningAddress', 'displayName']);
const ENSURE_BODY_KEYS = new Set(['aadObjectId', 'displayName', 'email']);
const ZAP_BODY_KEYS = new Set(['senderOid', 'recipientOid', 'amountSats', 'memo', 'idempotencyKey']);
const REWARD_BODY_KEYS = new Set([
  'recipientOid',
  'recipientLabel',
  'amountSats',
  'memo',
  'reward',
  'idempotencyKey',
]);
const REWARD_FIELDS = new Set(['eventType', 'repo', 'source', 'baseSats', 'bonusSats', 'level']);

const hasOnlyKeys = (body, allowed) =>
  typeof body === 'object' &&
  body !== null &&
  !Array.isArray(body) &&
  Object.keys(body).every((key) => allowed.has(key));

const optionalString = (value, max) =>
  value === undefined || value === null || (typeof value === 'string' && value.length <= max);

const validReward = (reward) =>
  reward === undefined ||
  (hasOnlyKeys(reward, REWARD_FIELDS) &&
    Object.values(reward).every(
      (value) => (typeof value === 'string' && value.length <= 200) || Number.isSafeInteger(value),
    ));

const createDirectoryRouter = ({
  directory = defaultDirectory,
  requireMsalOid = defaultRequireMsalOid,
  internalAuth = authMiddleware,
  adminAuth = requireAdmin,
  sendZap = (input) => gateway.sendZap(input),
  payReward = (input) => gateway.payReward(input),
  zapRecords = defaultZapRecords,
} = {}) => {
  const router = express.Router();

  const route = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };

  const provisioning = () => (directory().autoProvisionEnabled() ? 'automatic' : 'operator');

  // --- the signed-in person ------------------------------------------------

  router.get(
    '/me',
    route(async (req, res) => {
      const oid = await requireMsalOid(req, res);
      if (!oid) return;
      const person = directory().requirePerson(oid);
      let balances = { allowanceSats: null, budget: null };
      try {
        balances = await directory().balancesFor(oid);
      } catch (error) {
        // A balance read failing must not hide the registration form.
        console.warn('Directory balances unavailable:', error.message);
      }
      res.json({ ...toPublicPerson(person), ...balances, provisioning: provisioning() });
    }),
  );

  router.put(
    '/me/receive',
    route(async (req, res) => {
      const oid = await requireMsalOid(req, res);
      if (!oid) return;
      const body = req.body;
      if (
        !hasOnlyKeys(body, RECEIVE_BODY_KEYS) ||
        body.lightningAddress === undefined ||
        !optionalString(body.lightningAddress, 320)
      ) {
        res.status(400).json({ error: 'send lightningAddress' });
        return;
      }
      const person = await directory().setReceiveTarget(oid, { lightningAddress: body.lightningAddress });
      res.json(toPublicPerson(person));
    }),
  );

  // --- operators -----------------------------------------------------------

  router.get(
    '/admin/people',
    adminAuth,
    route(async (_req, res) => {
      res.json({
        provisioning: provisioning(),
        people: directory().store().list().map(toPublicPerson),
      });
    }),
  );

  router.put(
    '/admin/people/:oid/allowance-wallet',
    adminAuth,
    route(async (req, res) => {
      const oid = normalizeOid(req.params.oid);
      const body = req.body;
      if (
        !oid ||
        !hasOnlyKeys(body, LINK_BODY_KEYS) ||
        typeof body.nwcUrl !== 'string' ||
        body.nwcUrl.length > 2048 ||
        !optionalString(body.lightningAddress, 320) ||
        !optionalString(body.displayName, 256)
      ) {
        res.status(400).json({ error: 'send the Entra object id, the NWC connection string and the Lightning address' });
        return;
      }
      const { person, balanceSats } = await directory().linkAllowanceWallet({
        oid,
        displayName: body.displayName,
        nwcUrl: body.nwcUrl,
        lightningAddress: body.lightningAddress,
      });
      res.json({ person: toPublicPerson(person), balanceSats });
    }),
  );

  router.post(
    '/admin/people/:oid/provision',
    adminAuth,
    route(async (req, res) => {
      const oid = normalizeOid(req.params.oid);
      if (!oid) {
        res.status(400).json({ error: 'invalid Entra object id' });
        return;
      }
      if (!directory().autoProvisionEnabled()) {
        res.status(409).json({ error: 'Automatic provisioning is off; link a wallet instead' });
        return;
      }
      const result = await directory().ensurePerson({ oid });
      res.json({ person: toPublicPerson(result.person), createdWallets: result.createdWallets });
    }),
  );

  // --- the bot -------------------------------------------------------------

  router.use('/internal', internalAuth);

  router.get(
    '/internal/people',
    route(async (_req, res) => {
      res.json({ people: directory().store().list().map(toPublicPerson) });
    }),
  );

  // The bot calls this on every turn of a member it has already gated
  // (src/services/memberGate.ts), so it provisions like a portal sign-in.
  router.post(
    '/internal/people/ensure',
    route(async (req, res) => {
      const body = req.body;
      if (
        !hasOnlyKeys(body, ENSURE_BODY_KEYS) ||
        !normalizeOid(body.aadObjectId) ||
        !optionalString(body.displayName, 256) ||
        !optionalString(body.email, 320)
      ) {
        res.status(400).json({ error: 'invalid person' });
        return;
      }
      const result = await directory().ensurePerson({
        oid: body.aadObjectId,
        displayName: body.displayName,
        email: body.email,
      });
      res.json({
        person: toPublicPerson(result.person),
        created: result.created,
        awaitingOperator: result.awaitingOperator,
      });
    }),
  );

  router.get(
    '/internal/people/:oid',
    route(async (req, res) => {
      const person = directory().store().get(req.params.oid);
      if (!person) {
        res.status(404).json({ error: 'not in the directory' });
        return;
      }
      res.json({ person: toPublicPerson(person) });
    }),
  );

  router.get(
    '/internal/people/:oid/balances',
    route(async (req, res) => {
      res.json(await directory().balancesFor(req.params.oid));
    }),
  );

  // A payment answer always says whether money may have left: `outcome`
  // 'not_paid' (safe to retry) or 'unknown' (reconcile, never retry blind).
  const payRoute = (pay) =>
    route(async (req, res) => {
      try {
        const result = await pay(req, res);
        if (result) res.json({ paymentHash: result.payment_hash, outcome: 'paid' });
      } catch (error) {
        const status = Number.isInteger(error.status) ? error.status : 502;
        const outcome = error.paymentOutcome === 'not_paid' ? 'not_paid' : 'unknown';
        console.error('Directory payment failed:', req.path, outcome, error.message);
        res.status(status).json({
          error: status >= 500 && !error.expose ? 'the payment could not be completed' : error.message,
          outcome,
        });
      }
    });

  // A zap between two directory members, both named by Entra id. The
  // recipient's invoice is made here from their registered address.
  router.post(
    '/internal/zaps',
    payRoute(async (req, res) => {
      const body = req.body;
      if (!hasOnlyKeys(body, ZAP_BODY_KEYS) || !normalizeOid(body.senderOid)) {
        res.status(400).json({ error: 'invalid zap', outcome: 'not_paid' });
        return null;
      }
      return sendZap({
        aadObjectId: normalizeOid(body.senderOid),
        recipientUserId: body.recipientOid,
        amount: body.amountSats,
        memo: body.memo,
        idempotencyKey: body.idempotencyKey,
        source: 'bot',
      });
    }),
  );

  // An automation reward from the Treasury to a directory member.
  router.post(
    '/internal/rewards',
    payRoute(async (req, res) => {
      const body = req.body;
      if (
        !hasOnlyKeys(body, REWARD_BODY_KEYS) ||
        !optionalString(body.recipientLabel, 256) ||
        !validReward(body.reward)
      ) {
        res.status(400).json({ error: 'invalid reward payment', outcome: 'not_paid' });
        return null;
      }
      return payReward({
        recipientOid: body.recipientOid,
        recipientLabel: body.recipientLabel,
        amountSats: body.amountSats,
        memo: body.memo,
        reward: body.reward,
        idempotencyKey: body.idempotencyKey,
      });
    }),
  );

  // Every zap and reward Zaplie paid, newest first (the bot's leaderboard and
  // history). Names, Entra ids, amounts and memos only.
  router.get(
    '/internal/zaps',
    route(async (req, res) => {
      const since = Number.parseInt(String(req.query.since || ''), 10);
      res.json({ zaps: zapRecords().list(Number.isSafeInteger(since) && since > 0 ? { since } : {}) });
    }),
  );

  router.use((error, req, res, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 502;
    const path = `${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]}`;
    console.error('Directory request failed:', path, error.message);
    res.status(status).json({
      error: status >= 500 && !error.expose ? 'the Zaplie directory is unavailable' : error.message,
    });
  });

  return router;
};

module.exports = createDirectoryRouter();
module.exports.createDirectoryRouter = createDirectoryRouter;
