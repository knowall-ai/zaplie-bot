// filepath: tabs/backend/bountiesRoutes.js
// Open bounties: an admin posts a task with a sat prize, teammates submit
// their work (many submissions per bounty), and the admin pays the winning
// submission straight from the treasury into that person's Private wallet.
// States: open -> paid (or cancelled). Legacy claimed bounties still pay out.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { requireAdmin } = require('./adminAuth');
const { requireLnbitsConfig, getLnbitsToken, lnbitsGet } = require('./lnbitsAdmin');

const router = express.Router();

const STORE_PATH = path.join(__dirname, 'bounties.json');
const TREASURY_USERNAME = process.env.TREASURY_USERNAME || 'automation';

const readStore = () => {
  if (!fs.existsSync(STORE_PATH)) {
    return { bounties: [] };
  }
  const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  for (const bounty of store.bounties) {
    bounty.submissions = bounty.submissions || [];
    bounty.objectives = bounty.objectives || [];
    bounty.winnerSubmissionId = bounty.winnerSubmissionId || null;
  }
  return store;
};

const writeStore = (store) => {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
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

// GET /api/bounties — shared org view.
router.get('/', async (req, res) => {
  if (!(await requireMsalOid(req, res))) {
    return;
  }
  try {
    res.json({ bounties: readStore().bounties });
  } catch (error) {
    console.error('Reading bounties failed:', error.message);
    res.status(500).json({ error: 'could not read bounties' });
  }
});

const DIFFICULTIES = ['easy', 'intermediate', 'high'];

// POST /api/bounties — admin publishes a bounty.
router.post('/', requireAdmin, (req, res) => {
  const { title, description, amountSats, difficulty, category, deadlineDays } = req.body || {};
  if (
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    typeof description !== 'string' ||
    !Number.isInteger(amountSats) ||
    amountSats <= 0
  ) {
    res.status(400).json({ error: 'title, description and a positive integer amountSats are required' });
    return;
  }
  if (difficulty !== undefined && !DIFFICULTIES.includes(difficulty)) {
    res.status(400).json({ error: `difficulty must be one of ${DIFFICULTIES.join(', ')}` });
    return;
  }
  if (deadlineDays !== undefined && (!Number.isInteger(deadlineDays) || deadlineDays <= 0)) {
    res.status(400).json({ error: 'deadlineDays must be a positive integer' });
    return;
  }
  const store = readStore();
  const bounty = {
    id: crypto.randomUUID(),
    title: title.trim(),
    description: description.trim(),
    amountSats,
    difficulty: difficulty || 'intermediate',
    category: typeof category === 'string' && category.trim() ? category.trim() : 'Task',
    deadlineAt: deadlineDays
      ? new Date(Date.now() + deadlineDays * 86400000).toISOString()
      : null,
    status: 'open',
    createdAt: new Date().toISOString(),
    submissions: [],
    objectives: [],
    winnerSubmissionId: null,
    claimantAad: null,
    claimantName: null,
    claimedAt: null,
    paymentHash: null,
    paidAt: null,
  };
  store.bounties.push(bounty);
  writeStore(store);
  res.status(201).json(bounty);
});

// POST /api/bounties/:id/submissions — a teammate submits their work.
router.post('/:id/submissions', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  try {
    const store = readStore();
    const bounty = store.bounties.find((b) => b.id === req.params.id);
    if (!bounty) {
      res.status(404).json({ error: 'unknown bounty' });
      return;
    }
    if (bounty.status !== 'open') {
      res.status(409).json({ error: `bounty is ${bounty.status}` });
      return;
    }
    if (bounty.deadlineAt && Date.parse(bounty.deadlineAt) < Date.now()) {
      res.status(409).json({ error: 'bounty deadline has passed' });
      return;
    }
    if (bounty.submissions.some((s) => s.aad === oid)) {
      res.status(409).json({ error: 'you already submitted to this bounty' });
      return;
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!note) {
      res.status(400).json({ error: 'a short note describing your work is required' });
      return;
    }
    if (note.length > 500) {
      res.status(400).json({ error: 'the note must be 500 characters or fewer' });
      return;
    }

    const config = requireLnbitsConfig();
    const accessToken = await getLnbitsToken(config);
    const usersBody = await lnbitsGet(`${config.nodeUrl}/users/api/v1/user`, accessToken);
    const person = (Array.isArray(usersBody?.data) ? usersBody.data : []).find(
      (user) => user.external_id === oid,
    );
    if (!person) {
      res.status(404).json({ error: 'no wallet account for this person' });
      return;
    }

    bounty.submissions.push({
      id: crypto.randomUUID(),
      aad: oid,
      name: toDisplayName(person),
      note,
      submittedAt: new Date().toISOString(),
    });
    writeStore(store);
    res.status(201).json(bounty);
  } catch (error) {
    console.error('Submitting to bounty failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

// POST /api/bounties/:id/objective — toggle this bounty as a personal objective.
router.post('/:id/objective', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  const store = readStore();
  const bounty = store.bounties.find((b) => b.id === req.params.id);
  if (!bounty) {
    res.status(404).json({ error: 'unknown bounty' });
    return;
  }
  if (bounty.status !== 'open') {
    res.status(409).json({ error: `bounty is ${bounty.status}` });
    return;
  }
  const existing = bounty.objectives.findIndex((o) => o.aad === oid);
  if (existing >= 0) {
    bounty.objectives.splice(existing, 1);
  } else {
    bounty.objectives.push({ aad: oid, setAt: new Date().toISOString() });
  }
  writeStore(store);
  res.json(bounty);
});

// POST /api/bounties/:id/pay — admin pays the winning submission from the
// treasury. Body: { submissionId }. Legacy claimed bounties pay their claimant.
router.post('/:id/pay', requireAdmin, async (req, res) => {
  try {
    const store = readStore();
    const bounty = store.bounties.find((b) => b.id === req.params.id);
    if (!bounty) {
      res.status(404).json({ error: 'unknown bounty' });
      return;
    }

    let winner = null;
    if (bounty.status === 'claimed') {
      winner = { aad: bounty.claimantAad, name: bounty.claimantName, id: null };
    } else if (bounty.status === 'open') {
      const submissionId = req.body?.submissionId;
      if (!submissionId) {
        res.status(400).json({ error: 'submissionId of the winning submission is required' });
        return;
      }
      const submission = bounty.submissions.find((s) => s.id === submissionId);
      if (!submission) {
        res.status(404).json({ error: 'unknown submission' });
        return;
      }
      winner = { aad: submission.aad, name: submission.name, id: submission.id };
    } else {
      res.status(409).json({ error: `bounty is ${bounty.status}` });
      return;
    }

    const config = requireLnbitsConfig();
    const accessToken = await getLnbitsToken(config);
    const usersBody = await lnbitsGet(`${config.nodeUrl}/users/api/v1/user`, accessToken);
    const rawUsers = Array.isArray(usersBody?.data) ? usersBody.data : [];

    const claimant = rawUsers.find((user) => user.external_id === winner.aad);
    if (!claimant) {
      res.status(404).json({ error: 'winner has no wallet account' });
      return;
    }
    const claimantWallets = await lnbitsGet(
      `${config.nodeUrl}/users/api/v1/user/${claimant.id}/wallet`,
      accessToken,
    );
    const privateWallet = claimantWallets.find((w) => !w.deleted && w.name === 'Private');
    if (!privateWallet) {
      res.status(409).json({ error: 'claimant has no Private wallet' });
      return;
    }

    const treasury = rawUsers.find((user) => user.username === TREASURY_USERNAME);
    if (!treasury) {
      res.status(503).json({ error: `treasury user "${TREASURY_USERNAME}" not found` });
      return;
    }
    const treasuryWallets = await lnbitsGet(
      `${config.nodeUrl}/users/api/v1/user/${treasury.id}/wallet`,
      accessToken,
    );
    const treasuryWallet = treasuryWallets.find((w) => !w.deleted);
    if (!treasuryWallet) {
      res.status(503).json({ error: 'treasury has no wallet' });
      return;
    }
    if (treasuryWallet.balance_msat / 1000 < bounty.amountSats) {
      res.status(402).json({ error: 'treasury balance is not enough for this bounty' });
      return;
    }

    const invoiceResponse = await fetch(`${config.nodeUrl}/api/v1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': privateWallet.inkey },
      body: JSON.stringify({ out: false, amount: bounty.amountSats, memo: `Bounty: ${bounty.title}` }),
    });
    if (!invoiceResponse.ok) {
      throw new Error(`claimant invoice failed (status: ${invoiceResponse.status})`);
    }
    const invoice = await invoiceResponse.json();
    const bolt11 = invoice.payment_request || invoice.bolt11;
    if (!bolt11) {
      throw new Error('claimant invoice response missing bolt11');
    }

    const payResponse = await fetch(`${config.nodeUrl}/api/v1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': treasuryWallet.adminkey },
      body: JSON.stringify({ out: true, bolt11 }),
    });
    if (!payResponse.ok) {
      const detail = await payResponse.text();
      throw new Error(`bounty payment failed (status: ${payResponse.status}): ${detail}`);
    }
    const payment = await payResponse.json();

    bounty.status = 'paid';
    bounty.paymentHash = payment.payment_hash || invoice.payment_hash || '';
    bounty.paidAt = new Date().toISOString();
    bounty.winnerSubmissionId = winner.id;
    bounty.claimantAad = winner.aad;
    bounty.claimantName = winner.name;
    writeStore(store);
    res.json(bounty);
  } catch (error) {
    console.error('Paying bounty failed:', error.message);
    res.status(502).json({ error: 'could not pay the bounty' });
  }
});

// POST /api/bounties/:id/cancel — admin withdraws an open bounty.
router.post('/:id/cancel', requireAdmin, (req, res) => {
  const store = readStore();
  const bounty = store.bounties.find((b) => b.id === req.params.id);
  if (!bounty) {
    res.status(404).json({ error: 'unknown bounty' });
    return;
  }
  if (bounty.status !== 'open') {
    res.status(409).json({ error: `bounty is ${bounty.status}` });
    return;
  }
  bounty.status = 'cancelled';
  writeStore(store);
  res.json(bounty);
});

module.exports = router;
