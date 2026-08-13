// Achievements are derived from LNbits zap history. They are not persisted as
// badges; a short cache only avoids repeating the same expensive aggregation.
const express = require('express');
const {
  requireLnbitsConfig,
  getLnbitsToken,
  lnbitsGet,
} = require('./lnbitsAdmin');

const router = express.Router();
const PAGE_SIZE = 500;
const MAX_PAGES = 40;
const CACHE_TTL_MS = 15_000;
const cache = new Map();

const extractPayments = body => {
  if (Array.isArray(body)) return body;
  return body?.data || body?.payments || body?.items || [];
};

const paymentKey = payment =>
  String(payment.checking_id || payment.payment_hash || '').replace(
    /^internal_/,
    '',
  );

const paymentTime = payment => {
  if (typeof payment.time === 'number') return payment.time;
  const milliseconds = Date.parse(payment.time);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : 0;
};

const weekKey = seconds => {
  const monday = new Date(seconds * 1000);
  const daysSinceMonday = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
};

const reachedAt = (events, target, valueOf) => {
  let total = 0;
  for (const event of events) {
    total += valueOf(event);
    if (total >= target) return new Date(event.time * 1000).toISOString();
  }
  return null;
};

async function listPayments(config, accessToken) {
  const payments = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const body = await lnbitsGet(
      `${config.nodeUrl}/api/v1/payments/all/paginated?limit=${PAGE_SIZE}&offset=${offset}&sortby=time&direction=desc`,
      accessToken,
    );
    const batch = extractPayments(body);
    payments.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return payments;
}

async function computeAchievements(aadObjectId) {
  const config = requireLnbitsConfig();
  const accessToken = await getLnbitsToken(config);
  const usersBody = await lnbitsGet(
    `${config.nodeUrl}/users/api/v1/user`,
    accessToken,
  );
  const users = Array.isArray(usersBody?.data) ? usersBody.data : [];
  const currentUser = users.find(user => user.external_id === aadObjectId);
  if (!currentUser) return null;

  const walletOwners = new Map();
  await Promise.all(
    users.map(async user => {
      const wallets = await lnbitsGet(
        `${config.nodeUrl}/users/api/v1/user/${user.id}/wallet`,
        accessToken,
      );
      for (const wallet of wallets || []) {
        if (wallet.deleted !== true) {
          walletOwners.set(wallet.id, { userId: user.id, name: wallet.name });
        }
      }
    }),
  );

  const paymentsByKey = new Map();
  for (const payment of await listPayments(config, accessToken)) {
    const key = paymentKey(payment);
    if (!key) continue;
    const group = paymentsByKey.get(key) || [];
    group.push(payment);
    paymentsByKey.set(key, group);
  }

  const zaps = [];
  for (const payments of paymentsByKey.values()) {
    const outgoing = payments.find(payment => {
      const owner = walletOwners.get(payment.wallet_id);
      return owner?.name === 'Allowance' && payment.amount < 0;
    });
    const incoming = payments.find(payment => {
      const owner = walletOwners.get(payment.wallet_id);
      return owner?.name === 'Private' && payment.amount > 0;
    });
    if (!outgoing || !incoming) continue;

    const sender = walletOwners.get(outgoing.wallet_id)?.userId;
    const recipient = walletOwners.get(incoming.wallet_id)?.userId;
    if (!sender || !recipient || sender === recipient) continue;
    zaps.push({
      sender,
      recipient,
      sats: Math.floor(Math.abs(outgoing.amount) / 1000),
      time: paymentTime(outgoing),
    });
  }

  const sent = zaps
    .filter(zap => zap.sender === currentUser.id)
    .sort((a, b) => a.time - b.time);
  const received = zaps
    .filter(zap => zap.recipient === currentUser.id)
    .sort((a, b) => a.time - b.time);
  const sentSats = sent.reduce((total, zap) => total + zap.sats, 0);
  const receivedSats = received.reduce((total, zap) => total + zap.sats, 0);

  const firstByRecipient = new Map();
  const firstByWeek = new Map();
  for (const zap of sent) {
    if (!firstByRecipient.has(zap.recipient)) {
      firstByRecipient.set(zap.recipient, zap);
    }
    const week = weekKey(zap.time);
    if (!firstByWeek.has(week)) firstByWeek.set(week, zap);
  }
  const recipientMilestones = [...firstByRecipient.values()];
  const weekMilestones = [...firstByWeek.values()];

  const achievements = [
    {
      id: 'first-recognition',
      name: 'First recognition',
      description: 'Send your first zap to a teammate.',
      target: 1,
      current: Math.min(sent.length, 1),
      earnedAt: sent[0] ? new Date(sent[0].time * 1000).toISOString() : null,
    },
    {
      id: 'generous-1k',
      name: 'Generous giver',
      description: 'Give 1,000 sats of recognition in total.',
      target: 1000,
      current: sentSats,
      earnedAt: reachedAt(sent, 1000, zap => zap.sats),
    },
    {
      id: 'team-connector',
      name: 'Team connector',
      description: 'Recognise 3 different teammates.',
      target: 3,
      current: firstByRecipient.size,
      earnedAt: recipientMilestones[2]
        ? new Date(recipientMilestones[2].time * 1000).toISOString()
        : null,
    },
    {
      id: 'well-recognised',
      name: 'Well recognised',
      description: 'Receive 1,000 sats of recognition from the team.',
      target: 1000,
      current: receivedSats,
      earnedAt: reachedAt(received, 1000, zap => zap.sats),
    },
    {
      id: 'regular-recogniser',
      name: 'Regular recogniser',
      description: 'Send recognition in 3 different weeks.',
      target: 3,
      current: firstByWeek.size,
      earnedAt: weekMilestones[2]
        ? new Date(weekMilestones[2].time * 1000).toISOString()
        : null,
    },
  ].map(achievement => ({
    ...achievement,
    earned: achievement.earnedAt !== null,
  }));

  return {
    achievements,
    summary: {
      earnedCount: achievements.filter(achievement => achievement.earned)
        .length,
      totalCount: achievements.length,
    },
  };
}

function getAchievements(aadObjectId) {
  const now = Date.now();
  const cached = cache.get(aadObjectId);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = computeAchievements(aadObjectId);
  cache.set(aadObjectId, { promise, expiresAt: now + CACHE_TTL_MS });
  promise.catch(() => {
    if (cache.get(aadObjectId)?.promise === promise) cache.delete(aadObjectId);
  });
  return promise;
}

router.get('/for-person', async (req, res) => {
  const aadObjectId = req.query.aad;
  if (typeof aadObjectId !== 'string' || !aadObjectId) {
    res.status(400).json({ error: 'aad query parameter is required' });
    return;
  }
  try {
    const result = await getAchievements(aadObjectId);
    if (!result) {
      res.status(404).json({ error: 'no wallet account for this person' });
      return;
    }
    res.json(result);
  } catch (error) {
    console.error('Achievements computation failed:', error.message);
    res.status(502).json({ error: 'achievements could not be computed' });
  }
});

module.exports = router;
module.exports.computeAchievements = computeAchievements;
module.exports.getAchievements = getAchievements;
