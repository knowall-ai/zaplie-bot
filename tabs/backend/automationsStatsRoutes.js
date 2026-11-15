// filepath: tabs/backend/automationsStatsRoutes.js
// Header stats for the Automations page: what the treasury actually paid out
// this month. Shared org view, so any authenticated tenant user may read it.
const express = require('express');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { treasuryInkey } = require('./lnbitsConfig');
const { lnbitsRequest } = require('./lnbitsClient');
const { peopleStore } = require('./peopleStore');
const fs = require('fs');
const {
  summarizeAutomationPayments,
  summarizeBudgetSpend,
} = require('./automationPayments');
const { dataPath } = require('./dataPaths');
const { readEffectiveBudget } = require('./rewardBudget');

const router = express.Router();

// The budget the bot enforces, for "spent this period": the REWARDS_BUDGET_*
// overrides first, then the portal's budget, as the bot resolves it. A
// malformed environment or store shows no budget rather than failing the
// whole stats panel; the bot fails closed on the same config independently.
const readBudget = () => {
  try {
    return readEffectiveBudget(() =>
      JSON.parse(fs.readFileSync(dataPath('data.json'), 'utf8')),
    );
  } catch (error) {
    console.warn('Reward budget unavailable for stats:', error.message);
    return null;
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

  // The treasury is identified by its key, not by an LNbits username.
  const walletKey = treasuryInkey();
  if (!walletKey) {
    res.status(503).json({ error: 'ZAPLIE_TREASURY_INKEY must be set' });
    return;
  }

  try {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const sinceTs = Math.floor(monthStart.getTime() / 1000);

    const payments = await lnbitsRequest('/api/v1/payments?limit=1000', { walletKey });
    if (!Array.isArray(payments)) {
      throw new Error('treasury payments response is not an array');
    }
    // Recipients are named from the directory; extra.to.user is their Entra id.
    const people = peopleStore()
      .list()
      .map((person) => ({ id: person.oid, name: person.displayName }));
    res.json({
      ...summarizeAutomationPayments(payments, people, sinceTs),
      spentThisPeriod: summarizeBudgetSpend(payments, readBudget(), Date.now()),
    });
  } catch (error) {
    console.error('Automations stats failed:', error.message);
    res.status(502).json({ error: 'automation stats are unavailable' });
  }
});

module.exports = router;
