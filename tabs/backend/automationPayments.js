const parseObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (_error) {
      return {};
    }
  }
  return {};
};

const paymentEpoch = (time) => {
  if (typeof time === 'number' && Number.isFinite(time)) {
    return time;
  }
  if (typeof time === 'string') {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }
  return null;
};

const audienceForUser = (user) => {
  const type = String(parseObject(user?.extra).type || user?.type || '').toLowerCase();
  if (type === 'copilot') {
    return 'copilots';
  }
  if (type === 'guest' || type === 'customer') {
    return 'customers';
  }
  return 'teammates';
};

const buildRecipient = (payment, usersById) => {
  const extra = parseObject(payment.extra);
  const to = parseObject(extra.to);
  const userId = typeof to.user === 'string' && to.user ? to.user : null;
  const walletId = typeof to.id === 'string' && to.id ? to.id : null;
  const recipientId = userId || walletId || 'unattributed';
  const user = userId ? usersById.get(userId) : undefined;
  const userExtra = parseObject(user?.extra);
  const displayName =
    user?.name ||
    userExtra.displayName ||
    to.displayName ||
    user?.username ||
    user?.email ||
    (recipientId === 'unattributed'
      ? 'Unattributed recipient'
      : `Recipient ${recipientId.slice(0, 8)}`);

  return {
    id: recipientId,
    displayName: String(displayName),
    audience: audienceForUser(user),
  };
};

const summarizeAutomationPayments = (payments, rawUsers, sinceTs) => {
  if (!Array.isArray(payments)) {
    throw new Error('treasury payments response is not an array');
  }
  if (!Array.isArray(rawUsers)) {
    throw new Error('LNbits users response is not an array');
  }

  const usersById = new Map(
    rawUsers
      .filter((user) => typeof user?.id === 'string' && user.id.length > 0)
      .map((user) => [user.id, user]),
  );
  const outgoing = payments
    .filter(
      (payment) => {
        const extra = parseObject(payment?.extra);
        return (
          typeof payment?.amount === 'number' &&
          Number.isFinite(payment.amount) &&
          payment.amount < 0 &&
          extra.automation === true
        );
      },
    )
    .map((payment) => ({ payment, paidAtEpoch: paymentEpoch(payment.time) }))
    .sort((left, right) => (right.paidAtEpoch || 0) - (left.paidAtEpoch || 0));

  const monthly = outgoing.filter(
    ({ paidAtEpoch }) => paidAtEpoch !== null && paidAtEpoch >= sinceTs,
  );
  const engagement = new Map();
  for (const { payment, paidAtEpoch } of monthly) {
    const recipient = buildRecipient(payment, usersById);
    const sats = Math.round(Math.abs(payment.amount) / 1000);
    const current = engagement.get(recipient.id) || {
      ...recipient,
      paymentCount: 0,
      paidSats: 0,
      lastPaidAt: null,
    };
    current.paymentCount += 1;
    current.paidSats += sats;
    if (paidAtEpoch !== null) {
      const paidAt = new Date(paidAtEpoch * 1000).toISOString();
      if (!current.lastPaidAt || paidAt > current.lastPaidAt) {
        current.lastPaidAt = paidAt;
      }
    }
    engagement.set(recipient.id, current);
  }

  const ranked = [...engagement.values()].sort(
    (left, right) =>
      right.paymentCount - left.paymentCount ||
      right.paidSats - left.paidSats ||
      left.displayName.localeCompare(right.displayName),
  );
  const engagementByAudience = {
    teammates: ranked.filter((recipient) => recipient.audience === 'teammates').slice(0, 4),
    copilots: ranked.filter((recipient) => recipient.audience === 'copilots').slice(0, 4),
    customers: ranked.filter((recipient) => recipient.audience === 'customers').slice(0, 4),
  };

  const recentPayments = outgoing.slice(0, 10).map(({ payment, paidAtEpoch }) => {
    const extra = parseObject(payment.extra);
    return {
      id: String(payment.payment_hash || payment.checking_id || `${payment.time}-${payment.amount}`),
      amountSats: Math.round(Math.abs(payment.amount) / 1000),
      memo: typeof payment.memo === 'string' && payment.memo ? payment.memo : 'Automated reward',
      source: typeof extra.source === 'string' && extra.source ? extra.source : 'automation',
      paidAt: paidAtEpoch === null ? null : new Date(paidAtEpoch * 1000).toISOString(),
      recipient: buildRecipient(payment, usersById),
    };
  });

  return {
    paidSatsThisMonth: Math.round(
      monthly.reduce((total, { payment }) => total + Math.abs(payment.amount) / 1000, 0),
    ),
    paymentsThisMonth: monthly.length,
    engagementByAudience,
    recentPayments,
  };
};

module.exports = { paymentEpoch, summarizeAutomationPayments };
