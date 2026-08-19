const express = require('express');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { requireLnbitsConfig, getLnbitsToken } = require('./lnbitsAdmin');

const router = express.Router();

const PAYMENTS_LIMIT = 100;

const lnbitsGet = async (url, headers) => {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  if (!response.ok) {
    throw new Error(`LNbits request failed (status: ${response.status}): ${url}`);
  }
  return response.json();
};

const toDisplayName = (user) => {
  let displayName = user.username || user.id;
  if (displayName.includes('@')) {
    displayName = displayName.split('@')[0].replace('.', ' ');
    displayName = displayName
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  return displayName;
};

// Whitelist mapping: wallet admin/in keys must never reach the browser.
const toSafeUser = (user) => ({
  id: user.id,
  displayName: toDisplayName(user),
  profileImg: user.extra?.profileImg || '',
  aadObjectId: user.external_id || user.extra?.aadObjectId || '',
  email: user.email || user.extra?.email || user.username || '',
  type: user.extra?.type || 'Teammate',
});

router.get('/zap-history', async (req, res) => {
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

  const rawSinceTs = req.query.sinceTs;
  const sinceTs = Number(rawSinceTs);
  if (typeof rawSinceTs !== 'string' || rawSinceTs.trim() === '' || !Number.isFinite(sinceTs)) {
    res.status(400).json({
      error: `sinceTs must be a unix timestamp in seconds, received: ${JSON.stringify(rawSinceTs)}`,
    });
    return;
  }

  let config;
  try {
    config = requireLnbitsConfig();
  } catch (error) {
    console.error(error.message);
    res.status(503).json({ error: 'LNbits is not configured' });
    return;
  }

  try {
    const accessToken = await getLnbitsToken(config);
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    const usersBody = await lnbitsGet(`${config.nodeUrl}/users/api/v1/user`, authHeader);
    if (!Array.isArray(usersBody?.data)) {
      throw new Error('LNbits users response is missing the data array');
    }
    const rawUsers = usersBody.data;
    const allUsers = rawUsers.map(toSafeUser);

    const me = rawUsers.find(
      (user) => (user.external_id || user.extra?.aadObjectId) === oid,
    );
    if (!me) {
      res.json({ allUsers, zappedUserIds: [] });
      return;
    }

    const wallets = await lnbitsGet(
      `${config.nodeUrl}/users/api/v1/user/${me.id}/wallet`,
      authHeader,
    );
    if (!Array.isArray(wallets)) {
      throw new Error('LNbits wallets response is not an array');
    }
    const allowanceWallet = wallets.find(
      (wallet) =>
        wallet.deleted !== true &&
        typeof wallet.name === 'string' &&
        wallet.name.toLowerCase().includes('allowance'),
    );
    if (!allowanceWallet) {
      res.json({ allUsers, zappedUserIds: [] });
      return;
    }

    const payments = await lnbitsGet(
      `${config.nodeUrl}/api/v1/payments?limit=${PAYMENTS_LIMIT}`,
      { 'X-Api-Key': allowanceWallet.inkey },
    );

    if (!Array.isArray(payments)) {
      throw new Error('LNbits payments response is not an array');
    }
    const zappedUserIds = new Set();
    payments
      .filter((payment) => payment.amount < 0)
      .filter((payment) => !(payment.memo || '').includes('Weekly Allowance cleared'))
      .filter((payment) => Number(payment.time) >= sinceTs)
      .forEach((payment) => {
        const recipientId = payment.extra?.to?.user;
        if (recipientId) {
          zappedUserIds.add(recipientId);
        }
      });

    res.json({ allUsers, zappedUserIds: [...zappedUserIds] });
  } catch (error) {
    console.error('Zap history lookup failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

module.exports = router;
