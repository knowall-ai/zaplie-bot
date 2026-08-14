// filepath: tabs/backend/reportsRoutes.js
// Aggregated series for the Reports page. Recognition zaps are outgoing
// payments from Allowance wallets; automated payouts are outgoing payments
// from the treasury. Shared org view, any authenticated tenant user.
const express = require('express');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { requireLnbitsConfig, getLnbitsToken, lnbitsGet } = require('./lnbitsAdmin');

const router = express.Router();

const TREASURY_USERNAME = process.env.TREASURY_USERNAME || 'automation';
const WEEKS = 8;

const paymentEpoch = (time) =>
  typeof time === 'number' ? time : Date.parse(time) / 1000;

const walletOutgoingIntoBuckets = async (config, wallet, nowTs, buckets, totals) => {
  const response = await fetch(`${config.nodeUrl}/api/v1/payments?limit=1000`, {
    headers: { 'X-Api-Key': wallet.inkey },
  });
  if (!response.ok) {
    throw new Error(`payments fetch failed (status: ${response.status})`);
  }
  const list = await response.json();
  for (const payment of Array.isArray(list) ? list : []) {
    if (payment.amount >= 0 || payment.memo?.includes('Weekly Allowance cleared')) {
      continue;
    }
    const sats = Math.abs(payment.amount) / 1000;
    totals.sats += sats;
    totals.count += 1;
    const weeksAgo = Math.floor((nowTs - paymentEpoch(payment.time)) / (7 * 86400));
    if (weeksAgo >= 0 && weeksAgo < WEEKS) {
      buckets[WEEKS - 1 - weeksAgo] += sats;
    }
  }
};

router.get('/', async (req, res) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    await verifyMsalToken(token);
  } catch (error) {
    console.error('MSAL token validation failed:', error.message);
    res.status(401).json({ error: 'invalid token' });
    return;
  }

  try {
    const config = requireLnbitsConfig();
    const accessToken = await getLnbitsToken(config);
    const usersBody = await lnbitsGet(`${config.nodeUrl}/users/api/v1/user`, accessToken);
    const rawUsers = Array.isArray(usersBody?.data) ? usersBody.data : [];
    const nowTs = Math.floor(Date.now() / 1000);

    const zapsWeekly = new Array(WEEKS).fill(0);
    const automationWeekly = new Array(WEEKS).fill(0);
    const zapTotals = { sats: 0, count: 0 };
    const automationTotals = { sats: 0, count: 0 };

    await Promise.all(
      rawUsers.map(async (user) => {
        const wallets = await lnbitsGet(
          `${config.nodeUrl}/users/api/v1/user/${user.id}/wallet`,
          accessToken,
        );
        for (const wallet of wallets) {
          if (wallet.deleted === true) {
            continue;
          }
          if (user.username === TREASURY_USERNAME) {
            await walletOutgoingIntoBuckets(config, wallet, nowTs, automationWeekly, automationTotals);
          } else if (wallet.name === 'Allowance') {
            await walletOutgoingIntoBuckets(config, wallet, nowTs, zapsWeekly, zapTotals);
          }
        }
      }),
    );

    res.json({
      weeks: WEEKS,
      zapsWeekly: zapsWeekly.map(Math.round),
      automationWeekly: automationWeekly.map(Math.round),
      totalZapSats: Math.round(zapTotals.sats),
      totalZapCount: zapTotals.count,
      totalAutomatedSats: Math.round(automationTotals.sats),
      totalAutomatedCount: automationTotals.count,
    });
  } catch (error) {
    console.error('Reports aggregation failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

module.exports = router;
