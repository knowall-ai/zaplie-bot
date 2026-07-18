// filepath: tabs/backend/achievementsRoutes.js
// Achievements computed from real LNbits payments and bounty wins — no
// separate store to drift out of sync. /me serves the portal (MSAL token);
// /for-person serves the bot (internal token), which answers "what are my
// achievements" in Teams. Nostr NIP-58 badge publication is phase 2.
const express = require('express');
const fs = require('fs');
const path = require('path');
const authMiddleware = require('./authMiddleware');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { requireLnbitsConfig, getLnbitsToken, lnbitsGet } = require('./lnbitsAdmin');

const router = express.Router();

const BOUNTIES_PATH = path.join(__dirname, 'bounties.json');
const PAYMENTS_PAGE_LIMIT = 500;
const MAX_PAGES = 40;

const extractPayments = (body) => {
  if (Array.isArray(body)) {
    return body;
  }
  if (body && typeof body === 'object') {
    if (Array.isArray(body.data)) return body.data;
    if (Array.isArray(body.payments)) return body.payments;
    if (Array.isArray(body.items)) return body.items;
  }
  return [];
};

const paymentTimeSecs = (payment) =>
  typeof payment.time === 'number' ? payment.time : Date.parse(payment.time) / 1000;

const weekKey = (secs) => {
  const date = new Date(secs * 1000);
  const jan1 = new Date(date.getFullYear(), 0, 1);
  const week = Math.floor((date - jan1) / (7 * 86400000));
  return `${date.getFullYear()}-w${week}`;
};

// Walks events (ascending) accumulating `value` until `target` is reached and
// returns that event's timestamp, or null if the target was never reached.
const timeReached = (events, target, valueOf) => {
  let total = 0;
  for (const event of events) {
    total += valueOf(event);
    if (total >= target) {
      return new Date(event.time * 1000).toISOString();
    }
  }
  return null;
};

const computeAchievements = async (aadOid) => {
  const config = requireLnbitsConfig();
  const accessToken = await getLnbitsToken(config);

  const usersBody = await lnbitsGet(`${config.nodeUrl}/users/api/v1/user`, accessToken);
  const rawUsers = Array.isArray(usersBody?.data) ? usersBody.data : [];
  const person = rawUsers.find((user) => user.external_id === aadOid);
  if (!person) {
    return null;
  }

  const walletOwner = new Map(); // walletId -> { userId, name }
  await Promise.all(
    rawUsers.map(async (user) => {
      const wallets = await lnbitsGet(
        `${config.nodeUrl}/users/api/v1/user/${user.id}/wallet`,
        accessToken,
      );
      for (const wallet of wallets) {
        if (wallet.deleted !== true) {
          walletOwner.set(wallet.id, { userId: user.id, name: wallet.name });
        }
      }
    }),
  );

  const sentEvents = []; // { time, sats, hash }
  const receivedEvents = []; // { time, sats }
  const incomingUserByHash = new Map();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAYMENTS_PAGE_LIMIT;
    const url = `${config.nodeUrl}/api/v1/payments/all/paginated?limit=${PAYMENTS_PAGE_LIMIT}&offset=${offset}&sortby=time&direction=desc`;
    const payments = extractPayments(await lnbitsGet(url, accessToken));

    for (const payment of payments) {
      const owner = walletOwner.get(payment.wallet_id);
      if (!owner) {
        continue;
      }
      const memo = payment.memo || '';
      const time = paymentTimeSecs(payment);
      if (payment.amount > 0) {
        incomingUserByHash.set(payment.payment_hash, owner.userId);
        if (
          owner.userId === person.id &&
          owner.name === 'Private' &&
          !memo.startsWith('Bounty:')
        ) {
          receivedEvents.push({ time, sats: payment.amount / 1000 });
        }
      } else if (
        owner.userId === person.id &&
        owner.name === 'Allowance' &&
        memo !== 'Weekly Allowance cleared' &&
        !memo.startsWith('Redeem:')
      ) {
        sentEvents.push({
          time,
          sats: Math.abs(payment.amount) / 1000,
          hash: payment.payment_hash,
        });
      }
    }

    if (payments.length < PAYMENTS_PAGE_LIMIT) {
      break;
    }
  }
  sentEvents.sort((a, b) => a.time - b.time);
  receivedEvents.sort((a, b) => a.time - b.time);

  const recipients = [];
  const seenRecipients = new Set();
  for (const event of sentEvents) {
    const recipient = incomingUserByHash.get(event.hash);
    if (recipient && recipient !== person.id && !seenRecipients.has(recipient)) {
      seenRecipients.add(recipient);
      recipients.push(event);
    }
  }

  const weeks = [];
  const seenWeeks = new Set();
  for (const event of sentEvents) {
    const key = weekKey(event.time);
    if (!seenWeeks.has(key)) {
      seenWeeks.add(key);
      weeks.push(event);
    }
  }

  let bountyWins = [];
  if (fs.existsSync(BOUNTIES_PATH)) {
    const bounties = JSON.parse(fs.readFileSync(BOUNTIES_PATH, 'utf8')).bounties || [];
    bountyWins = bounties
      .filter((b) => b.status === 'paid' && b.claimantAad === aadOid)
      .sort((a, b) => Date.parse(a.paidAt) - Date.parse(b.paidAt));
  }

  const sentTotal = sentEvents.reduce((sum, e) => sum + e.sats, 0);
  const receivedTotal = receivedEvents.reduce((sum, e) => sum + e.sats, 0);

  const achievements = [
    {
      id: 'first-recognition',
      name: 'First recognition',
      description: 'Send your first zap to a teammate.',
      target: 1,
      current: Math.min(sentEvents.length, 1),
      earnedAt: sentEvents.length ? new Date(sentEvents[0].time * 1000).toISOString() : null,
    },
    {
      id: 'generous-1k',
      name: 'Generous giver',
      description: 'Give 1,000 sats of recognition in total.',
      target: 1000,
      current: Math.floor(sentTotal),
      earnedAt: timeReached(sentEvents, 1000, (e) => e.sats),
    },
    {
      id: 'team-connector',
      name: 'Team connector',
      description: 'Recognise 3 different teammates.',
      target: 3,
      current: recipients.length,
      earnedAt: recipients.length >= 3 ? new Date(recipients[2].time * 1000).toISOString() : null,
    },
    {
      id: 'well-recognised',
      name: 'Well recognised',
      description: 'Receive 1,000 sats of recognition from the team.',
      target: 1000,
      current: Math.floor(receivedTotal),
      earnedAt: timeReached(receivedEvents, 1000, (e) => e.sats),
    },
    {
      id: 'regular-recogniser',
      name: 'Regular recogniser',
      description: 'Send recognition in 3 different weeks.',
      target: 3,
      current: weeks.length,
      earnedAt: weeks.length >= 3 ? new Date(weeks[2].time * 1000).toISOString() : null,
    },
    {
      id: 'bounty-hunter',
      name: 'Bounty hunter',
      description: 'Win a bounty and get paid from the treasury.',
      target: 1,
      current: bountyWins.length,
      earnedAt: bountyWins.length ? bountyWins[0].paidAt : null,
    },
  ].map((achievement) => ({ ...achievement, earned: achievement.earnedAt !== null }));

  return {
    achievements,
    summary: {
      earnedCount: achievements.filter((a) => a.earned).length,
      totalCount: achievements.length,
    },
  };
};

// GET /api/achievements/me — the signed-in user's achievements (portal).
router.get('/me', async (req, res) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  let oid;
  try {
    oid = await verifyMsalToken(token);
  } catch (error) {
    console.error('MSAL token validation failed:', error.message);
    res.status(401).json({ error: 'invalid token' });
    return;
  }
  try {
    const result = await computeAchievements(oid);
    if (!result) {
      res.status(404).json({ error: 'no wallet account for this person' });
      return;
    }
    res.json(result);
  } catch (error) {
    console.error('Achievements computation failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

// GET /api/achievements/for-person?aad=<oid> — internal, used by the bot.
router.get('/for-person', authMiddleware, async (req, res) => {
  const aad = req.query.aad;
  if (typeof aad !== 'string' || !aad) {
    res.status(400).json({ error: 'aad query parameter is required' });
    return;
  }
  try {
    const result = await computeAchievements(aad);
    if (!result) {
      res.status(404).json({ error: 'no wallet account for this person' });
      return;
    }
    res.json(result);
  } catch (error) {
    console.error('Achievements computation failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

module.exports = router;
