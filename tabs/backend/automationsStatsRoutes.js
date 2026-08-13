// filepath: tabs/backend/automationsStatsRoutes.js
// Header stats for the Automations page: what the treasury actually paid out
// this month. Shared org view, so any authenticated tenant user may read it.
const express = require('express');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { requireLnbitsConfig, getLnbitsToken, lnbitsGet } = require('./lnbitsAdmin');
const { summarizeAutomationPayments } = require('./automationPayments');

const router = express.Router();

const TREASURY_USERNAME = process.env.TREASURY_USERNAME || 'automation';

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
    const treasury = (Array.isArray(usersBody?.data) ? usersBody.data : []).find(
      (user) => user.username === TREASURY_USERNAME,
    );
    if (!treasury) {
      res.status(503).json({ error: `treasury user "${TREASURY_USERNAME}" not found` });
      return;
    }

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const sinceTs = Math.floor(monthStart.getTime() / 1000);

    const wallets = await lnbitsGet(
      `${config.nodeUrl}/users/api/v1/user/${treasury.id}/wallet`,
      accessToken,
    );
    const paymentLists = await Promise.all(
      wallets
        .filter((wallet) => wallet.deleted !== true)
        .map(async (wallet) => {
          const response = await fetch(`${config.nodeUrl}/api/v1/payments?limit=1000`, {
            headers: { 'X-Api-Key': wallet.inkey },
          });
          if (!response.ok) {
            throw new Error(`treasury payments fetch failed (status: ${response.status})`);
          }
          return response.json();
        }),
    );
    res.json(
      summarizeAutomationPayments(paymentLists.flat(), usersBody.data, sinceTs),
    );
  } catch (error) {
    console.error('Automations stats failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

module.exports = router;
