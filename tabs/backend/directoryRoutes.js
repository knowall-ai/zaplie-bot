// filepath: tabs/backend/directoryRoutes.js
// The people directory over HTTP. Three audiences, three credentials:
//
//   /me/*        the signed-in person (verified MSAL token): see their own
//                wallets, register where they receive zaps.
//   /admin/*     Zaplie.Admin: see who is set up, link an Allowance wallet
//                created by hand in LNbits (the no-API-token path).
//   /internal/*  the bot (shared TAB_BACKEND_TOKEN): resolve and provision
//                people, invoice a recipient, read balances.
//
// Keys leave this server on exactly one route: /internal/people/ensure hands
// the bot the caller's own Allowance keys, because the bot pays from that
// wallet. Every other response goes through toPublicPerson.
const express = require('express');
const authMiddleware = require('./authMiddleware');
const { requireAdmin } = require('./adminAuth');
const { requireMsalOid: defaultRequireMsalOid } = require('./requireMsalOid');
const { walletDirectory: defaultDirectory } = require('./walletDirectory');
const { normalizeOid, toPublicPerson } = require('./peopleStore');
const { maxZapAmountSats } = require('./lnbitsGatewayService');
const { redactSensitive } = require('./lnbitsClient');

const RECEIVE_BODY_KEYS = new Set(['lightningAddress', 'invoiceKey']);
const LINK_BODY_KEYS = new Set(['adminkey', 'inkey', 'displayName']);
const ENSURE_BODY_KEYS = new Set(['aadObjectId', 'displayName', 'email']);
const INVOICE_BODY_KEYS = new Set(['amountSats', 'memo', 'extra']);
const MAX_MEMO = 500;
const MAX_EXTRA_BYTES = 2048;

const hasOnlyKeys = (body, allowed) =>
  typeof body === 'object' &&
  body !== null &&
  !Array.isArray(body) &&
  Object.keys(body).every((key) => allowed.has(key));

const optionalString = (value, max) =>
  value === undefined || value === null || (typeof value === 'string' && value.length <= max);

// The extra a zap invoice carries is built by the bot from names and ids. It
// is size-capped, and refused outright if any field is named like a key: the
// payee's wallet stores it where anyone with its invoice key can read it.
const validExtra = (extra) => {
  if (extra === undefined) return true;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return false;
  const text = JSON.stringify(extra);
  return text.length <= MAX_EXTRA_BYTES && JSON.stringify(redactSensitive(extra)) === text;
};

const createDirectoryRouter = ({
  directory = defaultDirectory,
  requireMsalOid = defaultRequireMsalOid,
  internalAuth = authMiddleware,
  adminAuth = requireAdmin,
} = {}) => {
  const router = express.Router();

  const route = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };

  // --- the signed-in person ------------------------------------------------

  router.get(
    '/me',
    route(async (req, res) => {
      const oid = await requireMsalOid(req, res);
      if (!oid) return;
      const person = directory().requirePerson(oid);
      let balances = { allowanceSats: null, privateSats: null };
      try {
        balances = await directory().balancesFor(oid);
      } catch (error) {
        // A balance read failing must not hide the registration form.
        console.warn('Directory balances unavailable:', error.message);
      }
      res.json({
        ...toPublicPerson(person),
        ...balances,
        provisioning: directory().tokenConfigured() ? 'automatic' : 'operator',
      });
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
        !optionalString(body.lightningAddress, 320) ||
        !optionalString(body.invoiceKey, 64) ||
        (body.lightningAddress === undefined && body.invoiceKey === undefined)
      ) {
        res.status(400).json({ error: 'send lightningAddress and/or invoiceKey' });
        return;
      }
      const person = await directory().setReceiveTarget(oid, {
        lightningAddress: body.lightningAddress,
        invoiceKey: body.invoiceKey,
      });
      res.json(toPublicPerson(person));
    }),
  );

  // --- operators -----------------------------------------------------------

  router.get(
    '/admin/people',
    adminAuth,
    route(async (_req, res) => {
      res.json({
        provisioning: directory().tokenConfigured() ? 'automatic' : 'operator',
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
        typeof body.adminkey !== 'string' ||
        typeof body.inkey !== 'string' ||
        !optionalString(body.displayName, 256)
      ) {
        res.status(400).json({ error: 'send the Entra object id, adminkey and inkey' });
        return;
      }
      const { person, ownershipVerified } = await directory().linkAllowanceWallet({
        oid,
        displayName: body.displayName,
        adminkey: body.adminkey,
        inkey: body.inkey,
      });
      res.json({ person: toPublicPerson(person), ownershipVerified });
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
      if (!directory().tokenConfigured()) {
        res.status(409).json({ error: 'LNBITS_API_TOKEN is not configured; link a wallet instead' });
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
      res.json({
        people: directory()
          .store()
          .list()
          .map((person) => ({
            ...toPublicPerson(person),
            // The invoice key only: it reads payments (leaderboard) and
            // cannot spend.
            allowanceWallet: person.allowance
              ? { id: person.allowance.walletId, inkey: person.allowance.inkey }
              : null,
          })),
      });
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
      const { person } = result;
      res.json({
        person: {
          ...toPublicPerson(person),
          allowanceWallet: person.allowance
            ? {
                id: person.allowance.walletId,
                adminkey: person.allowance.adminkey,
                inkey: person.allowance.inkey,
              }
            : null,
        },
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

  router.post(
    '/internal/people/:oid/invoices',
    route(async (req, res) => {
      const body = req.body;
      const amount = body?.amountSats;
      if (
        !normalizeOid(req.params.oid) ||
        !hasOnlyKeys(body, INVOICE_BODY_KEYS) ||
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        amount > maxZapAmountSats() ||
        typeof body.memo !== 'string' ||
        body.memo.length > MAX_MEMO ||
        !validExtra(body.extra)
      ) {
        res.status(400).json({ error: 'invalid invoice request' });
        return;
      }
      res.status(201).json(
        await directory().createInvoiceFor(req.params.oid, {
          amountSats: amount,
          memo: body.memo,
          extra: body.extra,
        }),
      );
    }),
  );

  router.use((error, req, res, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 502;
    const route = `${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]}`;
    console.error('Directory request failed:', route, error.message);
    res.status(status).json({
      error: status >= 500 && !error.expose ? 'the Zaplie directory is unavailable' : error.message,
    });
  });

  return router;
};

module.exports = createDirectoryRouter();
module.exports.createDirectoryRouter = createDirectoryRouter;
