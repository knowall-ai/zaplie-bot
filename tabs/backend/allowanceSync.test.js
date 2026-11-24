const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  applyPlan,
  gatherSnapshot,
  managedMemo,
  peopleFromUsers,
  planAllowanceSync,
  runAllowanceSync,
  snapshotOf,
} = require('./allowanceSync');
const { parseAllowancePolicy, emptyAllowancePolicy } = require('./allowancePolicy');
const { createAllowanceSyncStore } = require('./allowanceSyncStore');
const { desiredPayLink } = require('./payLinkService');

// Test values only: production has no default amount or schedule.
const NOW = new Date('2026-10-28T12:00:00Z');
const HOST = 'bank.example.test';
const POLICY = parseAllowancePolicy({
  enabled: true,
  amountSats: 25000,
  period: 'weekly',
  anchorWeekday: 5,
  anchorTime: '09:00',
  timezone: 'Europe/London',
  memo: 'Weekly allowance',
});
const OID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const OID_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const OID_C = 'cccccccc-0000-4000-8000-000000000003';
const FUND = { configured: true, wallets: [{ id: 'fund-1', name: 'Fund', balanceSats: 1_000_000 }] };
const person = (oid, extra = {}) => ({ oid, displayName: `P ${oid.slice(0, 4)}`, walletId: `w-${oid.slice(0, 4)}`, ...extra });
const linkFor = (oid, policy = POLICY) => ({
  id: `l-${oid.slice(0, 4)}`,
  ...desiredPayLink({
    oid,
    displayName: `P ${oid.slice(0, 4)}`,
    range: { minSats: policy.amountSats, maxSats: policy.amountSats, commentChars: 0 },
  }),
});
const rowFor = (oid, overrides = {}) => ({
  id: `r-${oid.slice(0, 4)}`,
  name: `zaplie:${oid}`,
  wallet: 'fund-1',
  revision: 2,
  lightning_address: `zaplie-${oid.replace(/-/g, '').slice(0, 12)}@${HOST}`,
  amount: 25000.0,
  currency: 'sats',
  memo: managedMemo(POLICY),
  active: true,
  frequency_type: 'weekly',
  timezone_name: 'Europe/London',
  start_datetime: '2026-10-30T09:00:00+00:00',
  next_payment_date: '2026-10-30T09:00:00+00:00',
  created_at: '2026-10-28T10:00:00+00:00',
  ...overrides,
});
const written = (row) => ({ allowanceId: row.id, written: snapshotOf(row) });

const plan = (overrides = {}) =>
  planAllowanceSync({
    people: [person(OID_A)],
    payLinks: { [`w-${OID_A.slice(0, 4)}`]: linkFor(OID_A) },
    allowances: [],
    fund: FUND,
    policy: POLICY,
    state: { byPerson: {} },
    now: NOW,
    publicHost: HOST,
    ...overrides,
  });
const kinds = (result) => result.actions.map((action) => `${action.kind}:${action.reason || ''}`);

test('planner: a new person gets a pay link and a schedule from the next anchor', () => {
  const result = plan({ payLinks: { [`w-${OID_A.slice(0, 4)}`]: null } });
  assert.deepEqual(kinds(result), ['paylink-create:', 'create:']);
  const create = result.actions[1];
  assert.deepEqual(create.body, {
    name: `zaplie:${OID_A}`,
    lightning_address: `zaplie-aaaaaaaa0000@${HOST}`,
    amount: 25000,
    currency: 'sats',
    memo: 'Weekly allowance [zaplie-managed]',
    active: true,
    frequency_type: 'weekly',
    start_datetime: '2026-10-30T09:00:00.000Z',
    timezone_name: 'Europe/London',
  });
  assert.equal(create.fundWalletId, 'fund-1');
  assert.equal(result.summary.totalPerPeriodSats, 25000);
  assert.equal(result.summary.changes, 2);
});

test('planner: a recorded Allowance address needs no pay link and is what the schedule pays', () => {
  // Since NWC Zaplie holds no Allowance wallet key: the operator created the
  // pay link in LNbits and the directory recorded its address.
  const result = plan({
    people: [{ ...person(OID_A), lightningAddress: `team-a@${HOST}` }],
    payLinks: {},
  });
  assert.deepEqual(kinds(result), ['create:']);
  assert.equal(result.actions[0].body.lightning_address, `team-a@${HOST}`);
});

test('planner table: create, update, recreate, delete, dedupe, drift, paused, leaver, fund-full', () => {
  const cases = [
    {
      name: 'matching row is a noop',
      allowances: [rowFor(OID_A)],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A)) } },
      expect: ['noop:'],
      total: 25000,
    },
    {
      name: 'policy amount change updates in place with the revision',
      allowances: [rowFor(OID_A, { amount: 20000 })],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A, { amount: 20000 })) } },
      expect: ['update:policy-changed'],
      check: (result) => {
        assert.deepEqual(result.actions[0].patch, { amount: 25000 });
        assert.equal(result.actions[0].revision, 2);
      },
      total: 25000,
    },
    {
      name: 'anchor change recreates (start and time zone are immutable)',
      allowances: [rowFor(OID_A, { start_datetime: '2026-10-29T09:00:00+00:00' })],
      state: {
        byPerson: { [OID_A]: written(rowFor(OID_A, { start_datetime: '2026-10-29T09:00:00+00:00' })) },
      },
      expect: ['recreate:schedule-changed'],
      total: 25000,
    },
    {
      name: 'time zone change recreates',
      allowances: [rowFor(OID_A, { timezone_name: 'UTC' })],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A, { timezone_name: 'UTC' })) } },
      expect: ['recreate:schedule-changed'],
      total: 25000,
    },
    {
      name: 'duplicates: the oldest stays, the rest are deleted',
      allowances: [
        rowFor(OID_A, { id: 'r-new', created_at: '2026-10-28T11:00:00+00:00' }),
        rowFor(OID_A, { id: 'r-old', created_at: '2026-10-27T11:00:00+00:00' }),
      ],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A, { id: 'r-old', created_at: '2026-10-27T11:00:00+00:00' })) } },
      expect: ['delete:duplicate', 'noop:'],
      check: (result) => assert.equal(result.actions[0].allowanceId, 'r-new'),
      total: 25000,
    },
    {
      name: 'hand edit is reported as drift, not overwritten',
      allowances: [rowFor(OID_A, { amount: 99999 })],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A)) } },
      expect: ['drift:edited-by-hand'],
      total: 99999,
    },
    {
      name: 'hand edit is overwritten when overwriteDrift is set',
      allowances: [rowFor(OID_A, { amount: 99999 })],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A)) } },
      overwriteDrift: true,
      expect: ['update:policy-changed'],
      total: 25000,
    },
    {
      name: 'an unrecorded row without the managed tag is drift (fail closed)',
      allowances: [rowFor(OID_A, { amount: 1, memo: 'set by hand' })],
      expect: ['drift:not-written-by-zaplie'],
      total: 1,
    },
    {
      name: 'an unrecorded row with the managed tag is adopted (the store is a cache)',
      allowances: [rowFor(OID_A, { amount: 1 })],
      expect: ['update:policy-changed'],
      total: 25000,
    },
    {
      name: 'an unrecorded paused row stays paused',
      allowances: [rowFor(OID_A, { active: false })],
      expect: ['paused:paused-by-hand'],
      total: 0,
    },
    {
      name: 'a schedule paused by hand is respected',
      allowances: [rowFor(OID_A, { active: false })],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A)) } },
      expect: ['paused:paused-by-hand'],
      total: 0,
    },
    {
      name: 'a schedule Zaplie paused is reactivated when the policy is on',
      allowances: [rowFor(OID_A, { active: false })],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A, { active: false })) } },
      expect: ['update:policy-changed'],
      check: (result) => assert.deepEqual(result.actions[0].patch, { active: true }),
      total: 25000,
    },
    {
      // The extension keeps next_payment_date on update and pays an active
      // row at once when it is past: recreate from the next anchor instead.
      name: 'a paused row whose next payment is past is recreated, not reactivated',
      allowances: [rowFor(OID_A, { active: false, next_payment_date: '2026-10-23T09:00:00+00:00' })],
      state: {
        byPerson: {
          [OID_A]: written(rowFor(OID_A, { active: false, next_payment_date: '2026-10-23T09:00:00+00:00' })),
        },
      },
      expect: ['recreate:reactivate-overdue'],
      check: (result) => {
        assert.equal(result.actions[0].allowanceId, 'r-aaaa');
        assert.equal(result.actions[0].body.start_datetime, '2026-10-30T09:00:00.000Z');
        assert.equal(result.actions[0].body.active, true);
      },
      total: 25000,
    },
    {
      name: 'a paused row due within the lead is recreated too',
      allowances: [rowFor(OID_A, { active: false, next_payment_date: '2026-10-28T12:03:00+00:00' })],
      state: {
        byPerson: {
          [OID_A]: written(rowFor(OID_A, { active: false, next_payment_date: '2026-10-28T12:03:00+00:00' })),
        },
      },
      expect: ['recreate:reactivate-overdue'],
      total: 25000,
    },
    {
      name: 'a paused row with no readable next payment date is recreated (fail closed)',
      allowances: [rowFor(OID_A, { active: false, next_payment_date: null })],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A, { active: false, next_payment_date: null })) } },
      expect: ['recreate:reactivate-overdue'],
      total: 25000,
    },
    {
      name: 'an in-flight duplicate is deferred, not deleted',
      allowances: [
        rowFor(OID_A, { id: 'r-new', created_at: '2026-10-28T11:00:00+00:00', pending_payment_hash: 'h' }),
        rowFor(OID_A, { id: 'r-old', created_at: '2026-10-27T11:00:00+00:00' }),
      ],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A, { id: 'r-old', created_at: '2026-10-27T11:00:00+00:00' })) } },
      expect: ['defer:payment-in-flight', 'noop:'],
      check: (result) => assert.equal(result.actions[0].allowanceId, 'r-new'),
      total: 50000,
    },
    {
      name: 'a leaver (no LNbits user) is deleted',
      people: [person(OID_A)],
      allowances: [rowFor(OID_A), rowFor(OID_B, { id: 'r-bbbb' })],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A)), [OID_B]: written(rowFor(OID_B, { id: 'r-bbbb' })) } },
      expect: ['delete:leaver', 'noop:'],
      total: 25000,
    },
    {
      name: 'an excluded person is treated as a leaver',
      people: [person(OID_A), person(OID_B)],
      policy: { ...POLICY, excludedOids: [OID_B] },
      allowances: [rowFor(OID_A), rowFor(OID_B, { id: 'r-bbbb' })],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A)) } },
      expect: ['delete:excluded', 'noop:'],
      total: 25000,
    },
    {
      name: 'a hand-edited leaver is reported, not deleted',
      people: [person(OID_A)],
      allowances: [rowFor(OID_A), rowFor(OID_B, { id: 'r-bbbb', amount: 5 })],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A)), [OID_B]: written(rowFor(OID_B, { id: 'r-bbbb' })) } },
      expect: ['drift:leaver-edited', 'noop:'],
      total: 25005,
    },
    {
      name: 'a payment in flight is deferred',
      allowances: [rowFor(OID_A, { amount: 1, pending_payment_hash: 'h' })],
      state: { byPerson: { [OID_A]: written(rowFor(OID_A, { amount: 1 })) } },
      expect: ['defer:payment-in-flight'],
      total: 1,
    },
    {
      name: 'a person with no Allowance wallet is skipped',
      people: [person(OID_A, { walletId: null, walletIssue: 'missing-wallet' })],
      expect: ['skip:missing-wallet'],
      total: 0,
    },
    {
      name: 'an unreadable pay link skips the person',
      payLinks: {},
      expect: ['skip:pay-link-unreadable'],
      total: 0,
    },
    {
      name: 'a full Fund wallet means fund-full',
      perWalletLimit: 1,
      allowances: [{ id: 'other', name: 'Not Zaplie', wallet: 'fund-1', amount: 5, active: true }],
      expect: ['skip:fund-full'],
      total: 0,
    },
    {
      name: 'creates spill over to the next Fund wallet',
      perWalletLimit: 1,
      fund: {
        configured: true,
        wallets: [
          { id: 'fund-1', name: 'Fund', balanceSats: 1_000_000 },
          { id: 'fund-2', name: 'Fund 2', balanceSats: 1_000_000 },
        ],
      },
      allowances: [{ id: 'other', name: 'Not Zaplie', wallet: 'fund-1', amount: 5, active: true }],
      expect: ['create:'],
      check: (result) => assert.equal(result.actions[0].fundWalletId, 'fund-2'),
      total: 25000,
    },
    {
      name: 'a schedule on a wallet without a configured key is left alone',
      allowances: [rowFor(OID_A, { wallet: 'elsewhere' })],
      expect: ['skip:unmanaged-fund-wallet'],
      total: 25000,
    },
  ];
  for (const testCase of cases) {
    const result = plan({
      ...(testCase.people ? { people: testCase.people } : {}),
      ...(testCase.payLinks ? { payLinks: testCase.payLinks } : {
        payLinks: Object.fromEntries(
          (testCase.people || [person(OID_A)]).map((p) => [p.walletId, linkFor(p.oid)]),
        ),
      }),
      ...(testCase.allowances ? { allowances: testCase.allowances } : {}),
      ...(testCase.state ? { state: testCase.state } : {}),
      ...(testCase.policy ? { policy: testCase.policy } : {}),
      ...(testCase.fund ? { fund: testCase.fund } : {}),
      ...(testCase.perWalletLimit ? { perWalletLimit: testCase.perWalletLimit } : {}),
      overwriteDrift: testCase.overwriteDrift || false,
    });
    assert.deepEqual(kinds(result), testCase.expect, testCase.name);
    assert.equal(result.summary.totalPerPeriodSats, testCase.total, `${testCase.name}: total`);
    if (testCase.check) testCase.check(result);
  }
});

test('planner: a disabled policy pauses every Zaplie schedule and creates nothing', () => {
  const disabled = { ...POLICY, enabled: false };
  const result = plan({
    policy: disabled,
    people: [person(OID_A), person(OID_C)],
    payLinks: {},
    allowances: [
      rowFor(OID_A),
      rowFor(OID_B, { id: 'r-bbbb' }),
      rowFor(OID_A, { id: 'r-dup', created_at: '2026-10-29T00:00:00+00:00' }),
    ],
  });
  assert.deepEqual(
    result.actions.map((action) => [action.kind, action.patch?.active]),
    [
      ['update', false],
      ['update', false],
      ['update', false],
    ],
  );
  assert.equal(result.summary.creates, 0);
  assert.equal(result.summary.paylinkCreates, 0);
  assert.equal(result.summary.deletes, 0);
  assert.equal(result.summary.totalPerPeriodSats, 0);
  assert.deepEqual(result.blockers, []);
});

test('planner: the unconfigured default policy plans nothing at all', () => {
  const result = plan({ policy: emptyAllowancePolicy(), payLinks: {} });
  assert.deepEqual(result.actions, []);
  assert.equal(result.summary.policyEnabled, false);
});

test('planner: without a Fund key only pay links are planned', () => {
  const result = plan({ fund: { configured: false, wallets: [] }, payLinks: { [`w-${OID_A.slice(0, 4)}`]: null } });
  assert.deepEqual(kinds(result), ['paylink-create:', 'skip:fund-not-configured']);
  assert.equal(result.warnings[0].code, 'fund-not-configured');
});

test('planner: underfunded blocks (overridably), below two periods warns, too many people blocks', () => {
  const people = [person(OID_A), person(OID_B), person(OID_C)];
  const payLinks = Object.fromEntries(people.map((p) => [p.walletId, linkFor(p.oid)]));
  const low = plan({
    people,
    payLinks,
    fund: { configured: true, wallets: [{ id: 'fund-1', name: 'Fund', balanceSats: 50000 }] },
  });
  assert.equal(low.summary.totalPerPeriodSats, 75000);
  assert.deepEqual(low.blockers.map((b) => [b.code, b.overridable]), [['underfunded', true]]);

  const thin = plan({
    people,
    payLinks,
    fund: { configured: true, wallets: [{ id: 'fund-1', name: 'Fund', balanceSats: 100000 }] },
  });
  assert.deepEqual(thin.blockers, []);
  assert.deepEqual(thin.warnings.map((w) => w.code), ['low-fund']);

  const crowd = plan({ people, payLinks, maxPeople: 2 });
  assert.deepEqual(crowd.blockers.map((b) => b.code), ['too-many-people']);
});

test('planner: an empty LNbits user list never deletes every schedule', () => {
  const result = plan({ people: [], allowances: [rowFor(OID_A)] });
  assert.ok(result.blockers.some((blocker) => blocker.code === 'no-people'));
});

test('planner: an incomplete LNbits user list deletes no leaver and blocks apply', () => {
  const allowances = [rowFor(OID_A), rowFor(OID_B, { id: 'r-bbbb' })];
  const state = {
    byPerson: { [OID_A]: written(rowFor(OID_A)), [OID_B]: written(rowFor(OID_B, { id: 'r-bbbb' })) },
  };
  const result = plan({ allowances, state, peopleComplete: false });
  assert.deepEqual(kinds(result), ['defer:people-incomplete', 'noop:']);
  assert.equal(result.summary.deletes, 0);
  assert.deepEqual(result.blockers.map((blocker) => blocker.code), ['people-incomplete']);
  // Excluded people are the admin's choice, not inferred from the list.
  const excluded = plan({
    people: [person(OID_A), person(OID_B)],
    payLinks: { [`w-${OID_A.slice(0, 4)}`]: linkFor(OID_A), [`w-${OID_B.slice(0, 4)}`]: linkFor(OID_B) },
    policy: { ...POLICY, excludedOids: [OID_B] },
    allowances,
    state,
    peopleComplete: false,
  });
  assert.deepEqual(kinds(excluded), ['delete:excluded', 'noop:']);
  assert.deepEqual(excluded.blockers, []);
});

test('planner: more leaver deletes than max(5, 10%) of the schedules blocks unless allowed', () => {
  const oid = (index) => `dddddddd-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const leavers = Array.from({ length: 6 }, (_, index) => oid(index + 1));
  const allowances = [rowFor(OID_A), ...leavers.map((o) => rowFor(o, { id: `r-${o.slice(-4)}` }))];
  const state = {
    byPerson: Object.fromEntries(
      allowances.map((row) => [row.name.slice('zaplie:'.length), { allowanceId: row.id, written: snapshotOf(row) }]),
    ),
  };
  const blocked = plan({ allowances, state });
  assert.equal(blocked.summary.deletes, 6);
  assert.deepEqual(blocked.blockers.map((blocker) => blocker.code), ['mass-delete']);
  assert.equal(blocked.blockers[0].overridable, undefined, 'allowUnderfunded does not lift it');

  const allowed = plan({ allowances, state, allowMassDelete: true });
  assert.equal(allowed.summary.deletes, 6);
  assert.deepEqual(allowed.blockers, []);

  const five = plan({ allowances: allowances.slice(0, 6), state });
  assert.equal(five.summary.deletes, 5);
  assert.deepEqual(five.blockers, [], 'five leavers are within the floor');
});

test('planner output never contains a key', () => {
  const result = plan({ payLinks: { [`w-${OID_A.slice(0, 4)}`]: null } });
  const text = JSON.stringify(result);
  assert.equal(/adminkey|inkey|X-Api-Key/i.test(text), false);
});

test('peopleFromUsers keeps directory entries keyed by Entra id and flags duplicates', () => {
  const people = peopleFromUsers([
    { id: OID_A, external_id: OID_A.toUpperCase(), extra: { display_name: 'Ada' } },
    { id: OID_A, external_id: OID_A },
    { id: 'u3', external_id: 'not-an-oid' },
    { id: OID_B, external_id: OID_B },
  ]);
  assert.deepEqual(
    people.map((p) => [p.oid, p.userId, p.displayName, Boolean(p.duplicate)]),
    [
      [OID_A, OID_A, 'Ada', true],
      [OID_B, OID_B, OID_B, false],
    ],
  );
});

// --- an in-memory LNbits for apply and full runs -----------------------------

const httpError = (status, detail = '') =>
  Object.assign(new Error(`LNbits request failed with status ${status}`), {
    upstreamStatus: status,
    upstreamDetail: detail,
  });

const createWorld = ({ users, fundWallets = [{ id: 'fund-1', name: 'Fund', balanceSats: 1_000_000 }], limit = 100 } = {}) => {
  const world = {
    rows: [],
    links: {},
    calls: [],
    nextId: 1,
    users,
    wallets: Object.fromEntries(
      users.map((user) => [
        user.id,
        [
          { id: `w-${user.id}`, name: 'Allowance', inkey: `in-${user.id}`, adminkey: `ad-${user.id}` },
          { id: `p-${user.id}`, name: 'Private', inkey: `pin-${user.id}`, adminkey: `pad-${user.id}` },
        ],
      ]),
    ),
  };
  const fundByKey = Object.fromEntries(fundWallets.map((wallet, index) => [`fundkey-${index}`, wallet]));
  world.clientFactory = (key) => {
    const fund = fundByKey[key];
    return {
      fundWallet: async () => ({ ...fund }),
      listAllowances: async () => world.rows.map((row) => ({ ...row })),
      getAllowance: async (id) => ({ ...world.rows.find((row) => row.id === id) }),
      health: async () => ({ healthy: true, overdue: 0, pending: 0 }),
      createAllowance: async (body) => {
        world.calls.push(['create', fund.id, body.name]);
        if (world.rows.filter((row) => row.wallet === fund.id).length >= limit) {
          throw httpError(422, 'Maximum 100 allowances per wallet');
        }
        const row = {
          id: `row-${world.nextId++}`,
          wallet: fund.id,
          revision: 0,
          created_at: NOW.toISOString(),
          next_payment_date: body.start_datetime,
          ...body,
        };
        world.rows.push(row);
        return { ...row };
      },
      updateAllowance: async (id, revision, patch) => {
        world.calls.push(['update', id, patch]);
        const row = world.rows.find((candidate) => candidate.id === id);
        if (!row) throw httpError(404);
        if (row.revision !== revision) throw httpError(409, 'Allowance changed; reload before saving');
        Object.assign(row, patch, { revision: row.revision + 1 });
        return { ...row };
      },
      deleteAllowance: async (id) => {
        world.calls.push(['delete', id]);
        world.rows = world.rows.filter((row) => row.id !== id);
        return {};
      },
    };
  };
  world.listUsers = async () => ({
    users: world.users,
    total: world.total ?? world.users.length,
    complete: world.total === undefined || world.users.length >= world.total,
  });
  world.listWallets = async (userId) => world.wallets[userId] || [];
  world.listLinks = async (wallet) => world.links[wallet.id] || [];
  world.createLink = async (wallet, body) => {
    assert.ok(wallet.adminkey, 'pay links are created with the wallet admin key');
    world.calls.push(['paylink-create', wallet.id]);
    const link = { id: `link-${wallet.id}`, wallet: wallet.id, ...body };
    world.links[wallet.id] = [...(world.links[wallet.id] || []), link];
    return link;
  };
  world.updateLink = async (wallet, linkId, body) => {
    world.calls.push(['paylink-update', wallet.id]);
    world.links[wallet.id] = world.links[wallet.id].map((link) =>
      link.id === linkId ? { ...link, ...body } : link,
    );
    return { id: linkId, ...body };
  };
  world.env = {
    ALLOWANCE_FUND_ADMINKEY: fundWallets.map((_, index) => `fundkey-${index}`).join(','),
    LNBITS_PUBLIC_HOST: HOST,
  };
  world.deps = (data, store) => ({
    readData: () => data,
    store,
    env: world.env,
    now: () => NOW,
    gather: (options) =>
      gatherSnapshot({
        ...options,
        listUsers: world.listUsers,
        listWallets: world.listWallets,
        listLinks: world.listLinks,
        clientFactory: world.clientFactory,
      }),
    apply: (planned, options) =>
      applyPlan(planned, { ...options, createLink: world.createLink, updateLink: world.updateLink }),
  });
  return world;
};

const tempStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowance-sync-'));
  return createAllowanceSyncStore({
    statePath: path.join(dir, 'allowance-sync.json'),
    auditPath: path.join(dir, 'allowance-audit.jsonl'),
  });
};

const USERS = [
  { id: 'u1', external_id: OID_A, extra: { display_name: 'Ada' } },
  { id: 'u2', external_id: OID_B, extra: { display_name: 'Bob' } },
];

test('run: preview, apply with the echoed total, then a second run is all noop', async () => {
  const world = createWorld({ users: USERS });
  const store = tempStore();
  const data = { allowancePolicy: POLICY };

  const preview = await runAllowanceSync({ mode: 'dry', by: 'test' }, world.deps(data, store));
  assert.equal(preview.summary.totalPerPeriodSats, 50000);
  assert.equal(preview.summary.changes, 4);
  assert.equal(world.calls.length, 0, 'a preview changes nothing');

  const applied = await runAllowanceSync(
    { mode: 'apply', confirmTotalSats: 50000, by: 'test' },
    world.deps(data, store),
  );
  assert.equal(applied.result.created, 2);
  assert.equal(applied.result.payLinks, 2);
  assert.equal(applied.result.errors, 0);
  assert.equal(world.rows.length, 2);
  assert.deepEqual(
    world.rows.map((row) => row.lightning_address).sort(),
    [`zaplie-aaaaaaaa0000@${HOST}`, `zaplie-bbbbbbbb0000@${HOST}`],
  );

  const callsAfterApply = world.calls.length;
  const second = await runAllowanceSync(
    { mode: 'apply', confirmTotalSats: 50000, by: 'test' },
    world.deps(data, store),
  );
  assert.equal(second.summary.changes, 0);
  assert.deepEqual([...new Set(second.actions.map((action) => action.kind))], ['noop']);
  assert.equal(world.calls.length, callsAfterApply, 'a second run changes nothing');

  const state = store.read();
  assert.equal(state.runs.length, 2);
  assert.equal(state.byPerson[OID_A].state, 'ok');
  const files = fs.readFileSync(store.statePath, 'utf8') + fs.readFileSync(store.auditPath, 'utf8');
  assert.equal(/fundkey|ad-u1|in-u1|adminkey|inkey/.test(files), false, 'no key reaches the store');
});

test('run: apply needs the preview total echoed back', async () => {
  const world = createWorld({ users: USERS });
  const store = tempStore();
  await assert.rejects(
    () => runAllowanceSync({ mode: 'apply', confirmTotalSats: 1 }, world.deps({ allowancePolicy: POLICY }, store)),
    (error) => error.status === 409 && error.code === 'confirm-mismatch',
  );
  await assert.rejects(
    () => runAllowanceSync({ mode: 'apply' }, world.deps({ allowancePolicy: POLICY }, store)),
    (error) => error.code === 'confirm-mismatch',
  );
  assert.equal(world.calls.length, 0);
});

test('run: apply is refused while the Fund holds less than one period, unless overridden', async () => {
  const world = createWorld({
    users: USERS,
    fundWallets: [{ id: 'fund-1', name: 'Fund', balanceSats: 30000 }],
  });
  const store = tempStore();
  const data = { allowancePolicy: POLICY };
  await assert.rejects(
    () => runAllowanceSync({ mode: 'apply', confirmTotalSats: 50000 }, world.deps(data, store)),
    (error) => error.code === 'underfunded',
  );
  assert.equal(world.calls.length, 0);
  const applied = await runAllowanceSync(
    { mode: 'apply', confirmTotalSats: 50000, allowUnderfunded: true },
    world.deps(data, store),
  );
  assert.equal(applied.result.created, 2);
});

test('run: apply without a Fund key is a 503 and touches nothing', async () => {
  const world = createWorld({ users: USERS });
  world.env = { LNBITS_PUBLIC_HOST: HOST };
  const store = tempStore();
  await assert.rejects(
    () => runAllowanceSync({ mode: 'apply', confirmTotalSats: 0 }, world.deps({ allowancePolicy: POLICY }, store)),
    (error) => error.status === 503 && error.code === 'fund-not-configured',
  );
  const preview = await runAllowanceSync({ mode: 'dry' }, world.deps({ allowancePolicy: POLICY }, store));
  assert.equal(preview.summary.paylinkCreates, 2);
  assert.equal(preview.summary.creates, 0);
});

test('run: the kill switch pauses every schedule and creates nothing', async () => {
  const world = createWorld({ users: USERS });
  const store = tempStore();
  await runAllowanceSync({ mode: 'apply', confirmTotalSats: 50000 }, world.deps({ allowancePolicy: POLICY }, store));
  const off = { allowancePolicy: { ...POLICY, enabled: false } };
  const preview = await runAllowanceSync({ mode: 'dry' }, world.deps(off, store));
  assert.equal(preview.summary.totalPerPeriodSats, 0);
  await runAllowanceSync({ mode: 'apply', confirmTotalSats: 0 }, world.deps(off, store));
  assert.equal(world.rows.length, 2, 'paused, not deleted');
  assert.ok(world.rows.every((row) => row.active === false));

  // Turning it back on reactivates what Zaplie paused.
  const back = await runAllowanceSync({ mode: 'dry' }, world.deps({ allowancePolicy: POLICY }, store));
  assert.deepEqual([...new Set(back.actions.map((action) => action.kind))], ['update']);
});

test('run: a revision conflict is reported as drift and never retried', async () => {
  const world = createWorld({ users: USERS.slice(0, 1) });
  const store = tempStore();
  await runAllowanceSync({ mode: 'apply', confirmTotalSats: 25000 }, world.deps({ allowancePolicy: POLICY }, store));
  const changed = { allowancePolicy: { ...POLICY, amountSats: 30000 } };
  const preview = await runAllowanceSync({ mode: 'dry' }, world.deps(changed, store));
  assert.deepEqual(preview.actions.map((action) => action.kind), ['paylink-update', 'update']);
  // Someone else bumps the revision between the plan and the update.
  const realFactory = world.clientFactory;
  world.clientFactory = (key) => {
    const client = realFactory(key);
    const list = client.listAllowances;
    client.listAllowances = async () => {
      const rows = await list();
      world.rows[0].revision += 1;
      return rows;
    };
    return client;
  };
  const applied = await runAllowanceSync({ mode: 'apply', confirmTotalSats: 30000 }, world.deps(changed, store));
  assert.equal(applied.result.drift, 1);
  assert.equal(applied.result.updated, 0);
  assert.equal(world.calls.filter(([kind]) => kind === 'update').length, 1);
  assert.equal(store.read().byPerson[OID_A].state, 'drift');
});

test('run: the extension limit moves creates to the next Fund wallet', async () => {
  const world = createWorld({
    users: USERS,
    limit: 1,
    fundWallets: [
      { id: 'fund-1', name: 'Fund', balanceSats: 1_000_000 },
      { id: 'fund-2', name: 'Fund 2', balanceSats: 1_000_000 },
    ],
  });
  const store = tempStore();
  // The planner believes both fit on fund-1 (limit 100); the extension says no.
  const applied = await runAllowanceSync(
    { mode: 'apply', confirmTotalSats: 50000 },
    world.deps({ allowancePolicy: POLICY }, store),
  );
  assert.equal(applied.result.created, 2);
  assert.deepEqual(world.rows.map((row) => row.wallet).sort(), ['fund-1', 'fund-2']);
});

test('run: an auth failure stops the run; a per-person refusal does not', async () => {
  const world = createWorld({ users: USERS });
  const store = tempStore();
  const realFactory = world.clientFactory;
  world.clientFactory = (key) => ({
    ...realFactory(key),
    createAllowance: async () => {
      throw httpError(401);
    },
  });
  const applied = await runAllowanceSync(
    { mode: 'apply', confirmTotalSats: 50000 },
    world.deps({ allowancePolicy: POLICY }, store),
  );
  assert.ok(applied.result.aborted);
  assert.ok(applied.errors.some((error) => error.error === 'aborted') || applied.result.errors >= 1);

  const world2 = createWorld({ users: USERS });
  const real2 = world2.clientFactory;
  let first = true;
  world2.clientFactory = (key) => {
    const client = real2(key);
    const create = client.createAllowance;
    client.createAllowance = async (body) => {
      if (first) {
        first = false;
        throw httpError(422, 'Invalid Lightning address or LNURL');
      }
      return create(body);
    };
    return client;
  };
  const partial = await runAllowanceSync(
    { mode: 'apply', confirmTotalSats: 50000 },
    world2.deps({ allowancePolicy: POLICY }, tempStore()),
  );
  assert.equal(partial.result.aborted, null);
  assert.equal(partial.result.created, 1);
  assert.equal(partial.result.errors, 1);
});

test('run: a pay link refused for one person skips their schedule and does not stop the run', async () => {
  const world = createWorld({ users: USERS });
  const realCreate = world.createLink;
  world.createLink = async (wallet, body) => {
    if (wallet.id === 'w-u1') throw httpError(403, 'Extension not enabled');
    return realCreate(wallet, body);
  };
  const applied = await runAllowanceSync(
    { mode: 'apply', confirmTotalSats: 50000 },
    world.deps({ allowancePolicy: POLICY }, tempStore()),
  );
  assert.equal(applied.result.aborted, null);
  assert.equal(applied.result.created, 1);
  assert.deepEqual(world.rows.map((row) => row.name), [`zaplie:${OID_B}`]);
  assert.equal(applied.result.errors, 1);
});

test('run: a Fund wallet named like a person wallet is refused', async () => {
  const world = createWorld({ users: USERS, fundWallets: [{ id: 'fund-1', name: 'Allowance', balanceSats: 1 }] });
  await assert.rejects(
    () => runAllowanceSync({ mode: 'dry' }, world.deps({ allowancePolicy: POLICY }, tempStore())),
    (error) => error.code === 'fund-misconfigured',
  );
});

test('run: a Fund wallet that belongs to a person is refused', async () => {
  const world = createWorld({ users: USERS, fundWallets: [{ id: 'w-u1', name: 'Fund', balanceSats: 1 }] });
  await assert.rejects(
    () => runAllowanceSync({ mode: 'dry' }, world.deps({ allowancePolicy: POLICY }, tempStore())),
    (error) => error.code === 'fund-misconfigured',
  );
});

test('run: a malformed stored policy fails closed before anything is read', async () => {
  const world = createWorld({ users: USERS });
  await assert.rejects(
    () => runAllowanceSync({ mode: 'dry' }, world.deps({ allowancePolicy: { enabled: true } }, tempStore())),
    (error) => error.code === 'policy-invalid',
  );
});

test('run: a person\'s apply records the policy it confirmed; the timer\'s does not', async () => {
  const stamped = { ...POLICY, updatedAt: '2026-10-28T09:00:00.000Z', updatedBy: 'admin' };
  const byTimer = createWorld({ users: USERS });
  const timerStore = tempStore();
  await runAllowanceSync(
    { mode: 'apply', confirmTotalSats: 50000, by: 'timer' },
    byTimer.deps({ allowancePolicy: stamped }, timerStore),
  );
  assert.equal(timerStore.read().lastAdminApply, undefined);

  const byAdmin = createWorld({ users: USERS });
  const adminStore = tempStore();
  await runAllowanceSync(
    { mode: 'apply', confirmTotalSats: 50000, by: 'admin-oid' },
    byAdmin.deps({ allowancePolicy: stamped }, adminStore),
  );
  assert.deepEqual(adminStore.read().lastAdminApply, {
    policyUpdatedAt: '2026-10-28T09:00:00.000Z',
    totalPerPeriodSats: 50000,
    at: NOW.toISOString(),
    by: 'admin-oid',
  });
});

test('run: only one sync at a time', async () => {
  const world = createWorld({ users: USERS });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const deps = world.deps({ allowancePolicy: POLICY }, tempStore());
  const slowGather = async (options) => {
    await gate;
    return deps.gather(options);
  };
  const first = runAllowanceSync({ mode: 'dry' }, { ...deps, gather: slowGather });
  await assert.rejects(
    () => runAllowanceSync({ mode: 'dry' }, deps),
    (error) => error.status === 409 && error.code === 'busy',
  );
  release();
  await first;
});

test('run: a user list short of its total deletes nobody and refuses apply', async () => {
  const world = createWorld({ users: USERS });
  const store = tempStore();
  const data = { allowancePolicy: POLICY };
  await runAllowanceSync({ mode: 'apply', confirmTotalSats: 50000 }, world.deps(data, store));
  assert.equal(world.rows.length, 2);

  // LNbits now pages: only the first account comes back, of the two announced.
  world.users = USERS.slice(0, 1);
  world.total = 2;
  const preview = await runAllowanceSync({ mode: 'dry' }, world.deps(data, store));
  assert.equal(preview.summary.deletes, 0);
  assert.deepEqual(preview.blockers.map((blocker) => blocker.code), ['people-incomplete']);
  const callsBefore = world.calls.length;
  await assert.rejects(
    () => runAllowanceSync({ mode: 'apply', confirmTotalSats: 50000 }, world.deps(data, store)),
    (error) => error.status === 409 && error.code === 'people-incomplete',
  );
  assert.equal(world.calls.length, callsBefore);
  assert.equal(world.rows.length, 2, 'no schedule was deleted');
});

test('run: lifting the kill switch after an anchor passed recreates from the next anchor', async () => {
  const world = createWorld({ users: USERS });
  const store = tempStore();
  await runAllowanceSync({ mode: 'apply', confirmTotalSats: 50000 }, world.deps({ allowancePolicy: POLICY }, store));
  const off = { allowancePolicy: { ...POLICY, enabled: false } };
  await runAllowanceSync({ mode: 'apply', confirmTotalSats: 0 }, world.deps(off, store));
  // The extension would have paid on the anchor; paused rows keep the date.
  for (const row of world.rows) row.next_payment_date = '2026-10-23T09:00:00+00:00';

  const back = await runAllowanceSync({ mode: 'dry' }, world.deps({ allowancePolicy: POLICY }, store));
  assert.deepEqual(
    back.actions.map((action) => `${action.kind}:${action.reason}`),
    ['recreate:reactivate-overdue', 'recreate:reactivate-overdue'],
  );
  const applied = await runAllowanceSync(
    { mode: 'apply', confirmTotalSats: 50000 },
    world.deps({ allowancePolicy: POLICY }, store),
  );
  assert.equal(applied.result.errors, 0);
  assert.ok(world.rows.every((row) => row.active === true));
  assert.ok(
    world.rows.every((row) => row.next_payment_date === '2026-10-30T09:00:00.000Z'),
    'nothing is due before the next anchor',
  );
  assert.equal(world.calls.filter(([call]) => call === 'update').length, 2, 'only the two pauses');
});

test('apply: start_datetime is computed when the create is sent, not when planned', async () => {
  const world = createWorld({ users: USERS.slice(0, 1) });
  const planned = plan({ allowances: [] });
  const create = planned.actions.find((action) => action.kind === 'create');
  assert.equal(create.body.start_datetime, '2026-10-30T09:00:00.000Z');
  const client = world.clientFactory('fundkey-0');
  // The run reached the create past Friday's anchor less the lead.
  const late = new Date('2026-10-30T08:57:00Z');
  const { results } = await applyPlan(
    { actions: [create] },
    { clients: new Map([['fund-1', client]]), wallets: new Map(), now: () => late },
  );
  assert.equal(results[0].ok, true);
  assert.equal(results[0].row.start_datetime, '2026-11-06T09:00:00.000Z');
  assert.ok(Date.parse(results[0].row.start_datetime) >= late.getTime() + 60_000);
});

test('run: the lock file keeps a second process out, and a stale lock is taken over', async () => {
  const world = createWorld({ users: USERS });
  const store = tempStore();
  const data = { allowancePolicy: POLICY };
  // Another process (the CLI or the portal) holds a fresh lock.
  fs.writeFileSync(
    store.lockPath,
    JSON.stringify({ pid: 4242, host: 'other', at: new Date().toISOString(), token: 'theirs' }),
  );
  await assert.rejects(
    () => runAllowanceSync({ mode: 'dry' }, world.deps(data, store)),
    (error) =>
      error.status === 409 && error.code === 'busy' && /pid 4242 on other/.test(error.message),
  );
  assert.equal(JSON.parse(fs.readFileSync(store.lockPath, 'utf8')).token, 'theirs', 'left alone');

  // The holder died 31 minutes ago: its lock is stale and is taken over.
  fs.writeFileSync(
    store.lockPath,
    JSON.stringify({ pid: 4242, host: 'other', at: new Date(Date.now() - 31 * 60 * 1000).toISOString(), token: 'theirs' }),
  );
  const preview = await runAllowanceSync({ mode: 'dry' }, world.deps(data, store));
  assert.equal(preview.summary.people, 2);
  assert.equal(fs.existsSync(store.lockPath), false, 'released after the run');
});

test('store: the lock is exclusive, names its holder, and only its holder releases it', () => {
  const store = tempStore();
  const first = store.acquireLock();
  assert.equal(first.acquired, true);
  const holder = JSON.parse(fs.readFileSync(store.lockPath, 'utf8'));
  assert.equal(holder.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(holder.at)));
  const second = store.acquireLock();
  assert.equal(second.acquired, false);
  assert.equal(second.holder.pid, process.pid);
  assert.equal(second.holder.token, undefined, 'the token is not exposed');
  second.release?.();
  assert.equal(fs.existsSync(store.lockPath), true);
  assert.equal(store.lockHolder().pid, process.pid);
  first.release();
  assert.equal(fs.existsSync(store.lockPath), false);
  assert.equal(store.lockHolder(), null);

  // A clock 31 minutes on makes a held lock stale.
  let nowMs = Date.now();
  const clocked = createAllowanceSyncStore({
    statePath: store.statePath,
    auditPath: store.auditPath,
    clock: () => nowMs,
  });
  const held = clocked.acquireLock();
  assert.equal(clocked.acquireLock().acquired, false);
  nowMs += 31 * 60 * 1000;
  const taken = clocked.acquireLock();
  assert.equal(taken.acquired, true);
  held.release();
  assert.equal(fs.existsSync(clocked.lockPath), true, 'the old holder cannot release the new lock');
  taken.release();
});

test('planner: one person in an incomplete directory never turns six schedules into leavers', () => {
  const oids = [OID_A, OID_B, OID_C, 'dddddddd-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000005', 'ffffffff-0000-4000-8000-000000000006'];
  const result = plan({
    people: [person(OID_A)],
    payLinks: { [`w-${OID_A.slice(0, 4)}`]: linkFor(OID_A) },
    allowances: oids.map((oid) => rowFor(oid)),
    peopleComplete: false,
  });
  assert.equal(result.actions.filter((action) => action.kind === 'delete').length, 0);
  assert.equal(result.actions.filter((action) => action.reason === 'people-incomplete').length, 5);
  assert.deepEqual(result.blockers.map((b) => b.code), ['people-incomplete']);
});
