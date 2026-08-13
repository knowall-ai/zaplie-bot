const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentEpoch, summarizeAutomationPayments } = require('./automationPayments');

const sinceTs = Date.parse('2024-01-01T00:00:00.000Z') / 1000;

test('summarizes real treasury history and engagement by stored audience', () => {
  const users = [
    { id: 'alice-id', name: 'Alice', extra: { type: 'Teammate' } },
    { id: 'bot-id', name: 'Build Copilot', extra: '{"type":"Copilot"}' },
    { id: 'customer-id', name: 'Northwind', extra: { type: 'Guest' } },
  ];
  const payments = [
    {
      payment_hash: 'alice-new',
      amount: -100000,
      time: '2024-02-03T10:00:00.000Z',
      memo: 'GitHub: PR #3 merged',
      extra: { automation: true, source: 'github', to: { user: 'alice-id' } },
    },
    {
      payment_hash: 'alice-old',
      amount: -50000,
      time: '2024-01-10T10:00:00.000Z',
      memo: 'GitHub: PR #2 merged',
      extra: { automation: true, source: 'github', to: { user: 'alice-id' } },
    },
    {
      payment_hash: 'copilot',
      amount: -200000,
      time: '2024-02-02T10:00:00.000Z',
      memo: 'Review submitted',
      extra: JSON.stringify({ automation: true, source: 'github', to: { user: 'bot-id' } }),
    },
    {
      payment_hash: 'customer',
      amount: -80000,
      time: '2024-02-01T10:00:00.000Z',
      memo: 'Customer milestone',
      extra: { automation: true, source: 'crm', to: { user: 'customer-id' } },
    },
    {
      payment_hash: 'manual-outgoing',
      amount: -500000,
      time: '2024-02-04T09:00:00.000Z',
      memo: 'Manual treasury transfer',
      extra: { source: 'manual', to: { user: 'alice-id' } },
    },
    {
      payment_hash: 'incoming',
      amount: 900000,
      time: '2024-02-04T10:00:00.000Z',
      memo: 'Treasury top-up',
    },
  ];

  const result = summarizeAutomationPayments(payments, users, sinceTs);

  assert.equal(result.paidSatsThisMonth, 430);
  assert.equal(result.paymentsThisMonth, 4);
  assert.deepEqual(result.engagementByAudience.teammates[0], {
    id: 'alice-id',
    displayName: 'Alice',
    audience: 'teammates',
    paymentCount: 2,
    paidSats: 150,
    lastPaidAt: '2024-02-03T10:00:00.000Z',
  });
  assert.equal(result.engagementByAudience.copilots[0].displayName, 'Build Copilot');
  assert.equal(result.engagementByAudience.customers[0].displayName, 'Northwind');
  assert.deepEqual(
    result.recentPayments.map((payment) => payment.id),
    ['alice-new', 'copilot', 'customer', 'alice-old'],
  );
});

test('counts this month runs per event type and ignores unlabelled payments', () => {
  const result = summarizeAutomationPayments(
    [
      {
        payment_hash: 'merged-1',
        amount: -1000000,
        time: '2024-02-01T10:00:00.000Z',
        extra: { automation: true, eventType: 'githubPrMerged', to: { user: 'alice-id' } },
      },
      {
        payment_hash: 'merged-2',
        amount: -1000000,
        time: '2024-02-02T10:00:00.000Z',
        extra: JSON.stringify({
          automation: true,
          eventType: 'githubPrMerged',
          to: { user: 'alice-id' },
        }),
      },
      {
        payment_hash: 'merged-before-month',
        amount: -1000000,
        time: '2023-12-02T10:00:00.000Z',
        extra: { automation: true, eventType: 'githubPrMerged', to: { user: 'alice-id' } },
      },
      {
        payment_hash: 'unlabelled',
        amount: -1000000,
        time: '2024-02-03T10:00:00.000Z',
        extra: { automation: true, to: { user: 'alice-id' } },
      },
      {
        payment_hash: 'polluting',
        amount: -1000000,
        time: '2024-02-04T10:00:00.000Z',
        extra: { automation: true, eventType: '__proto__', to: { user: 'alice-id' } },
      },
    ],
    [{ id: 'alice-id', name: 'Alice' }],
    sinceTs,
  );

  assert.equal(result.runsByEventType.githubPrMerged, 2);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.runsByEventType, 'githubIssueClosed'),
    false,
  );
  assert.equal(Object.getPrototypeOf(result.runsByEventType), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(result.runsByEventType, '__proto__').value, 1);
});

test('uses payment metadata when a recipient is not in the user directory', () => {
  const result = summarizeAutomationPayments(
    [
      {
        checking_id: 'payment-1',
        amount: -21000,
        time: sinceTs + 1,
        memo: 'Merged',
        extra: {
          automation: true,
          source: 'github',
          to: { user: 'missing-user', displayName: 'octocat' },
        },
      },
    ],
    [],
    sinceTs,
  );

  assert.equal(result.recentPayments[0].recipient.displayName, 'octocat');
  assert.equal(result.recentPayments[0].recipient.audience, 'teammates');
});

test('validates timestamps and upstream collection shapes', () => {
  assert.equal(paymentEpoch('2024-01-02T00:00:00.000Z'), 1704153600);
  assert.equal(paymentEpoch('invalid'), null);
  assert.throws(
    () => summarizeAutomationPayments(null, [], sinceTs),
    /treasury payments response is not an array/,
  );
  assert.throws(
    () => summarizeAutomationPayments([], null, sinceTs),
    /LNbits users response is not an array/,
  );
});
