// filepath: tabs/backend/teamRewardsRoutes.js
// Org-curated reward catalog (certifications, learning, time off) with a
// redemption request queue. Redeeming debits the user's Private wallet through
// payRedemption, so this route does move funds; an admin then fulfils the
// request itself.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { requireAdmin } = require('./adminAuth');
const { requireLnbitsConfig, getLnbitsToken, lnbitsGet } = require('./lnbitsAdmin');

const toDisplayName = (user) => {
  let displayName = user.username || user.email || user.id;
  if (displayName.includes('@')) {
    displayName = displayName
      .split('@')[0]
      .replace('.', ' ')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  return displayName;
};

const router = express.Router();

const TREASURY_USERNAME = process.env.TREASURY_USERNAME || 'automation';

const DATA_PATH = path.join(__dirname, 'data.json');
const REDEMPTIONS_PATH = path.join(__dirname, 'redemptions.json');

const DEFAULT_CATALOG = [
  {
    id: 'certification-voucher',
    category: 'Certification',
    name: 'Certification exam voucher',
    description: 'Any professional certification exam, for example Azure, AWS or Kubernetes. Your org books and pays the exam for you.',
    priceSats: 50000,
  },
  {
    id: 'course-budget',
    category: 'Learning',
    name: 'Course or book budget',
    description: 'A course, workshop or technical books of your choice, up to the equivalent budget.',
    priceSats: 25000,
  },
  {
    id: 'conference-day',
    category: 'Learning',
    name: 'Conference day',
    description: 'A paid day to attend a conference or meetup, travel not included.',
    priceSats: 40000,
  },
  {
    id: 'recharge-day',
    category: 'Time off',
    name: 'Recharge day',
    description: 'One extra day off, coordinated with your team.',
    priceSats: 60000,
  },
];

const readCatalog = () => {
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  return Array.isArray(raw.teamRewards) ? raw.teamRewards : DEFAULT_CATALOG;
};

const readRedemptions = () => {
  if (!fs.existsSync(REDEMPTIONS_PATH)) {
    return { redemptions: [] };
  }
  return JSON.parse(fs.readFileSync(REDEMPTIONS_PATH, 'utf8'));
};

const requireMsalOid = async (req, res) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return null;
  }
  try {
    return await verifyMsalToken(token);
  } catch (error) {
    console.error('MSAL token validation failed:', error.message);
    res.status(401).json({ error: 'invalid token' });
    return null;
  }
};

// GET /api/team-rewards — catalog, the caller's own pending requests, and the
// org-wide redemption history with names resolved.
router.get('/', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  try {
    const catalog = readCatalog();
    const catalogById = new Map(catalog.map((r) => [r.id, r]));
    const redemptions = readRedemptions().redemptions;
    const mine = redemptions.filter((r) => r.personAad === oid && r.status === 'requested');

    const config = requireLnbitsConfig();
    const accessToken = await getLnbitsToken(config);
    const usersBody = await lnbitsGet(`${config.nodeUrl}/users/api/v1/user`, accessToken);
    const nameByAad = new Map(
      (Array.isArray(usersBody?.data) ? usersBody.data : []).map((user) => [
        user.external_id,
        toDisplayName(user),
      ]),
    );

    const history = redemptions
      .slice()
      .reverse()
      .map((r) => ({
        id: r.id,
        rewardName: catalogById.get(r.rewardId)?.name || r.rewardId,
        personName: nameByAad.get(r.personAad) || 'Unknown',
        priceSats: r.priceSats ?? catalogById.get(r.rewardId)?.priceSats ?? 0,
        status: r.status,
        requestedAt: r.requestedAt,
        fulfilledAt: r.fulfilledAt || null,
      }));

    res.json({ rewards: catalog, myRequests: mine.map((r) => r.rewardId), history });
  } catch (error) {
    console.error('Reading team rewards failed:', error.message);
    res.status(500).json({ error: 'could not read team rewards' });
  }
});

// POST /api/team-rewards/redemptions/:id/fulfill — admin marks it delivered.
router.post('/redemptions/:id/fulfill', requireAdmin, (req, res) => {
  const store = readRedemptions();
  const redemption = store.redemptions.find((r) => r.id === req.params.id);
  if (!redemption) {
    res.status(404).json({ error: 'unknown redemption' });
    return;
  }
  if (redemption.status !== 'requested') {
    res.status(409).json({ error: `redemption is ${redemption.status}` });
    return;
  }
  redemption.status = 'fulfilled';
  redemption.fulfilledAt = new Date().toISOString();
  fs.writeFileSync(REDEMPTIONS_PATH, JSON.stringify(store, null, 2));
  res.json({ id: redemption.id, status: redemption.status, fulfilledAt: redemption.fulfilledAt });
});

// The redeemer pays the reward's price from their Private wallet into the
// treasury, then the request is filed for an admin to fulfil.
const payRedemption = async (oid, reward) => {
  const config = requireLnbitsConfig();
  const accessToken = await getLnbitsToken(config);

  const usersBody = await lnbitsGet(`${config.nodeUrl}/users/api/v1/user`, accessToken);
  const rawUsers = Array.isArray(usersBody?.data) ? usersBody.data : [];

  const person = rawUsers.find((u) => u.external_id === oid);
  if (!person) {
    return { status: 404, error: 'no wallet account for this person' };
  }
  const wallets = await lnbitsGet(
    `${config.nodeUrl}/users/api/v1/user/${person.id}/wallet`,
    accessToken,
  );
  const privateWallet = wallets.find((w) => !w.deleted && w.name === 'Private');
  if (!privateWallet) {
    return { status: 409, error: 'no Private wallet for this person' };
  }
  if (privateWallet.balance_msat / 1000 < reward.priceSats) {
    return { status: 402, error: 'not enough sats in your Private wallet' };
  }

  const treasury = rawUsers.find((u) => u.username === TREASURY_USERNAME);
  if (!treasury) {
    return { status: 503, error: `treasury user "${TREASURY_USERNAME}" not found` };
  }
  const treasuryWallets = await lnbitsGet(
    `${config.nodeUrl}/users/api/v1/user/${treasury.id}/wallet`,
    accessToken,
  );
  const treasuryWallet = treasuryWallets.find((w) => !w.deleted);
  if (!treasuryWallet) {
    return { status: 503, error: 'treasury has no wallet' };
  }

  const invoiceResponse = await fetch(`${config.nodeUrl}/api/v1/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': treasuryWallet.inkey },
    body: JSON.stringify({ out: false, amount: reward.priceSats, memo: `Redeem: ${reward.name}` }),
  });
  if (!invoiceResponse.ok) {
    throw new Error(`treasury invoice failed (status: ${invoiceResponse.status})`);
  }
  const invoice = await invoiceResponse.json();
  const bolt11 = invoice.payment_request || invoice.bolt11;
  if (!bolt11) {
    throw new Error('treasury invoice response missing bolt11');
  }

  const payResponse = await fetch(`${config.nodeUrl}/api/v1/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': privateWallet.adminkey },
    body: JSON.stringify({ out: true, bolt11 }),
  });
  if (!payResponse.ok) {
    const detail = await payResponse.text();
    throw new Error(`redemption payment failed (status: ${payResponse.status}): ${detail}`);
  }
  const payment = await payResponse.json();
  return { status: 200, paymentHash: payment.payment_hash || invoice.payment_hash || '' };
};

// POST /api/team-rewards/:id/redeem — pays the price into the treasury and
// files a request for an admin to fulfil.
router.post('/:id/redeem', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  try {
    const reward = readCatalog().find((r) => r.id === req.params.id);
    if (!reward) {
      res.status(404).json({ error: 'unknown reward' });
      return;
    }
    const store = readRedemptions();
    const alreadyRequested = store.redemptions.some(
      (r) => r.personAad === oid && r.rewardId === reward.id && r.status === 'requested',
    );
    if (alreadyRequested) {
      res.status(409).json({ error: 'already requested' });
      return;
    }

    const paid = await payRedemption(oid, reward);
    if (paid.status !== 200) {
      res.status(paid.status).json({ error: paid.error });
      return;
    }

    store.redemptions.push({
      id: crypto.randomUUID(),
      rewardId: reward.id,
      personAad: oid,
      priceSats: reward.priceSats,
      paymentHash: paid.paymentHash,
      status: 'requested',
      requestedAt: new Date().toISOString(),
    });
    fs.writeFileSync(REDEMPTIONS_PATH, JSON.stringify(store, null, 2));
    res.json({ status: 'requested', rewardId: reward.id });
  } catch (error) {
    console.error('Redeeming team reward failed:', error.message);
    res.status(500).json({ error: 'could not complete the redemption' });
  }
});

module.exports = router;
