// filepath: tabs/backend/reportsRoutes.js
// Aggregated series for the Reports page. Recognition zaps are outgoing
// payments from Allowance wallets; automated payouts are outgoing payments
// from the treasury. Shared org view, any authenticated tenant user.
//
// Both series come from Zaplie's own record of what it paid
// (zapRecordStore.js): zaps between members and rewards from the Treasury.
// Nothing here calls LNbits or any wallet.
const express = require('express');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { zapRecords } = require('./zapRecordStore');

const router = express.Router();

const WEEKS = 8;

const paymentEpoch = (time) =>
  typeof time === 'number' ? time : Date.parse(time) / 1000;

const intoBuckets = (record, nowTs, buckets, totals) => {
  totals.sats += record.amountSats;
  totals.count += 1;
  const weeksAgo = Math.floor((nowTs - paymentEpoch(record.time)) / (7 * 86400));
  if (weeksAgo >= 0 && weeksAgo < WEEKS) {
    buckets[WEEKS - 1 - weeksAgo] += record.amountSats;
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

    for (const record of zapRecords().list()) {
      if (record.kind === 'reward') {
        intoBuckets(record, nowTs, automationWeekly, automationTotals);
      } else {
        intoBuckets(record, nowTs, zapsWeekly, zapTotals);
      }
    }

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
    res.status(502).json({ error: 'reports are unavailable' });
  }
});

module.exports = router;
