// filepath: tabs/backend/automationsStatsRoutes.js
// Header stats for the Automations page: what the treasury actually paid out
// this month. Shared org view, so any authenticated tenant user may read it.
const express = require('express');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { requireLnbitsConfig, getLnbitsToken, lnbitsGet } = require('./lnbitsAdmin');

const router = express.Router();

const TREASURY_USERNAME = process.env.TREASURY_USERNAME || 'automation';

const paymentEpoch = (time) =>
  typeof time === 'number' ? time : Date.parse(time) / 1000;

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
    let paidSats = 0;
    let payments = 0;
    for (const wallet of wallets) {
      if (wallet.deleted === true) {
        continue;
      }
      const response = await fetch(`${config.nodeUrl}/api/v1/payments?limit=1000`, {
        headers: { 'X-Api-Key': wallet.inkey },
      });
      if (!response.ok) {
        throw new Error(`treasury payments fetch failed (status: ${response.status})`);
      }
      const list = await response.json();
      for (const payment of Array.isArray(list) ? list : []) {
        if (payment.amount < 0 && paymentEpoch(payment.time) >= sinceTs) {
          paidSats += Math.abs(payment.amount) / 1000;
          payments += 1;
        }
      }
    }
    res.json({ paidSatsThisMonth: Math.round(paidSats), paymentsThisMonth: payments });
  } catch (error) {
    console.error('Automations stats failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

module.exports = router;
