// filepath: tabs/backend/webhookKeysRoutes.js
// API keys for inbound reward flows (Logic Apps, Power Automate, timesheet
// systems). Keys are stored as SHA-256 hashes and shown in full exactly once
// at creation; the bot validates presented keys against the active hashes.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { requireAdmin } = require('./adminAuth');
const authMiddleware = require('./authMiddleware');

const router = express.Router();

const STORE_PATH = path.join(__dirname, 'webhook-keys.json');

const readStore = () => {
  if (!fs.existsSync(STORE_PATH)) {
    return { keys: [] };
  }
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
};

const writeStore = (store) => {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
};

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// GET /api/webhook-keys/hashes — internal, called by the bot to validate
// presented keys (same placeholder-token pattern as /api/automations, #171).
router.get('/hashes', authMiddleware, (req, res) => {
  const hashes = readStore()
    .keys.filter((key) => !key.revokedAt)
    .map((key) => key.hash);
  res.json({ hashes });
});

// GET /api/webhook-keys — admin: key metadata, never the secret.
router.get('/', requireAdmin, (req, res) => {
  const keys = readStore().keys.map(({ id, label, last4, createdAt, revokedAt }) => ({
    id,
    label,
    last4,
    createdAt,
    revokedAt,
  }));
  res.json({ keys });
});

// POST /api/webhook-keys — admin: create a key; the plaintext is returned once.
router.post('/', requireAdmin, (req, res) => {
  const { label } = req.body || {};
  if (typeof label !== 'string' || label.trim().length === 0) {
    res.status(400).json({ error: 'label is required' });
    return;
  }
  const key = `zpl_${crypto.randomBytes(24).toString('hex')}`;
  const store = readStore();
  const entry = {
    id: crypto.randomUUID(),
    label: label.trim(),
    hash: sha256(key),
    last4: key.slice(-4),
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  store.keys.push(entry);
  writeStore(store);
  res.status(201).json({
    key,
    id: entry.id,
    label: entry.label,
    last4: entry.last4,
    createdAt: entry.createdAt,
  });
});

// POST /api/webhook-keys/:id/revoke — admin: revoked keys stop working at once.
router.post('/:id/revoke', requireAdmin, (req, res) => {
  const store = readStore();
  const entry = store.keys.find((key) => key.id === req.params.id);
  if (!entry) {
    res.status(404).json({ error: 'unknown key' });
    return;
  }
  if (!entry.revokedAt) {
    entry.revokedAt = new Date().toISOString();
    writeStore(store);
  }
  res.json({ id: entry.id, revokedAt: entry.revokedAt });
});

module.exports = router;
