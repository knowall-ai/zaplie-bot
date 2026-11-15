// filepath: tabs/backend/reportsRoutes.js
// Aggregated series for the Reports page. Recognition zaps are outgoing
// payments from Allowance wallets; automated payouts are outgoing payments
// from the treasury. Shared org view, any authenticated tenant user.
//
// Allowance wallets come from the people directory and are read with their
// invoice keys; the treasury is read with ZAPLIE_TREASURY_INKEY. Nothing here
// logs in to LNbits or lists its users.
const express = require('express');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { treasuryInkey } = require('./lnbitsConfig');
const { lnbitsRequest } = require('./lnbitsClient');
const { peopleStore } = require('./peopleStore');

const router = express.Router();

const WEEKS = 8;

const paymentEpoch = (time) =>
  typeof time === 'number' ? time : Date.parse(time) / 1000;

const walletOutgoingIntoBuckets = async (walletKey, nowTs, buckets, totals) => {
  const list = await lnbitsRequest('/api/v1/payments?limit=1000', { walletKey });
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
    const nowTs = Math.floor(Date.now() / 1000);

    const zapsWeekly = new Array(WEEKS).fill(0);
    const automationWeekly = new Array(WEEKS).fill(0);
    const zapTotals = { sats: 0, count: 0 };
    const automationTotals = { sats: 0, count: 0 };

    const allowanceKeys = peopleStore()
      .list()
      .map((person) => person.allowance?.inkey)
      .filter(Boolean);
    await Promise.all(
      allowanceKeys.map((walletKey) =>
        walletOutgoingIntoBuckets(walletKey, nowTs, zapsWeekly, zapTotals),
      ),
    );
    const treasuryKey = treasuryInkey();
    if (treasuryKey) {
      await walletOutgoingIntoBuckets(treasuryKey, nowTs, automationWeekly, automationTotals);
    }

    res.json({
      weeks: WEEKS,
      zapsWeekly: zapsWeekly.map(Math.round),
      automationWeekly: automationWeekly.map(Math.round),
      totalZapSats: Math.round(zapTotals.sats),
      totalZapCount: zapTotals.count,
      totalAutomatedSats: Math.round(automationTotals.sats),
      totalAutomatedCount: automationTotals.count,
      // False when ZAPLIE_TREASURY_INKEY is unset: the automation series is
      // then unknown, not zero.
      treasuryConfigured: Boolean(treasuryKey),
    });
  } catch (error) {
    console.error('Reports aggregation failed:', error.message);
    res.status(502).json({ error: 'reports are unavailable' });
  }
});

module.exports = router;
