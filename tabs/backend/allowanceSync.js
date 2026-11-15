// Reconciles every person's weekly allowance schedule in the LNbits allowance
// extension with the admin's policy.
//
//   gather  -> read the Zaplie people directory, Allowance wallets, pay links, the Fund
//              wallet(s) and the extension's schedules
//   plan    -> planAllowanceSync, pure: the actions and a summary
//   apply   -> applyPlan: deletes first, then per person the pay link and
//              the schedule, four at a time
//
// Money safety (docs/SOLUTION_DESIGN.adoc, "Weekly allowances"):
// - nothing is created or reactivated unless the policy is enabled with an
//   amount; a disabled policy pauses Zaplie's schedules and creates nothing;
// - one schedule per person, identified by the name `zaplie:<oid>`; duplicates
//   are removed, every update carries the row's revision, a conflict is
//   reported and never retried blind, and one run at a time;
// - apply must echo the preview's total per period, and is refused while a
//   Fund wallet holds less than one period unless explicitly overridden;
// - Zaplie never pays: the Fund key only reaches the extension APIs.
const { listDirectoryUsers, listPersonWallets } = require('./walletGateway');

// Zaplie holds no Allowance wallet key since the move to NWC: each wallet's
// pay link is created in LNbits by an operator (or by automatic provisioning)
// and its address recorded in the directory. A plan from a directory entry
// never contains a pay-link action; these refuse one if a caller builds it.
const noWalletKeys = async () => {
  throw Object.assign(new Error('Zaplie holds no Allowance wallet keys to manage pay links'), {
    upstreamStatus: 403,
  });
};
const {
  isPolicyActive,
  payLinkRange,
  readAllowancePolicy,
} = require('./allowancePolicy');
const {
  createAllowanceExtensionClient,
  readFundKeys,
} = require('./allowanceExtensionClient');
const {
  desiredPayLink,
  findAllowancePayLink,
  payLinkDiff,
  publicLnbitsHost,
  updateBody,
  allowanceUsername,
} = require('./payLinkService');
const { MIN_LEAD_MS, nextAnchor, startMatchesAnchor } = require('./allowanceSchedule');

const NAME_PREFIX = 'zaplie:';
const TIMER_ACTOR = 'timer';
const MANAGED_TAG = '[zaplie-managed]';
const OID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PER_WALLET_LIMIT = 100;
const DEFAULT_MAX_PEOPLE = 1000;
const RESERVED_FUND_NAMES = new Set(['allowance', 'private']);
// More leaver deletes than this in one run is a blocker unless the admin
// passes allowMassDelete: max(5, 10% of Zaplie's schedules).
const MASS_DELETE_MIN = 5;
const MASS_DELETE_SHARE = 0.1;
const MUTABLE_FIELDS = ['lightning_address', 'amount', 'currency', 'memo', 'active'];
const SNAPSHOT_FIELDS = [
  ...MUTABLE_FIELDS,
  'name',
  'frequency_type',
  'timezone_name',
  'start_datetime',
];
const EXECUTABLE = new Set([
  'paylink-create',
  'paylink-update',
  'create',
  'update',
  'recreate',
  'delete',
]);

class AllowanceSyncError extends Error {
  constructor(message, status = 500, code = 'error') {
    super(message);
    this.name = 'AllowanceSyncError';
    this.status = status;
    this.code = code;
  }
}

const scheduleName = (oid) => `${NAME_PREFIX}${oid}`;

const managedMemo = (policy) =>
  policy.memo ? `${policy.memo} ${MANAGED_TAG}` : MANAGED_TAG;

const oidFromName = (name) => {
  if (typeof name !== 'string' || !name.startsWith(NAME_PREFIX)) return null;
  const oid = name.slice(NAME_PREFIX.length).toLowerCase();
  return OID_PATTERN.test(oid) ? oid : null;
};

const normaliseCurrency = (currency) =>
  currency === 'satoshis' ? 'sats' : String(currency || 'sats');

/** The fields Zaplie compares and remembers, normalised. Never a key. */
const snapshotOf = (row) => {
  if (!row) return null;
  const snapshot = {};
  for (const field of SNAPSHOT_FIELDS) {
    snapshot[field] = row[field] ?? null;
  }
  snapshot.amount = Number(row.amount);
  snapshot.currency = normaliseCurrency(row.currency);
  snapshot.memo = row.memo || '';
  snapshot.active = row.active !== false;
  snapshot.start_datetime = Number.isFinite(Date.parse(row.start_datetime))
    ? new Date(Date.parse(row.start_datetime)).toISOString()
    : null;
  return snapshot;
};

const sameSnapshot = (a, b) =>
  Boolean(a && b) && SNAPSHOT_FIELDS.every((field) => a[field] === b[field]);

const isInFlight = (row) =>
  Boolean(row.pending_payment_hash || row.retry_after || row.retry_resume_date);

const rowAge = (row) => {
  const created = Date.parse(row.created_at);
  return Number.isFinite(created) ? created : Number.MAX_SAFE_INTEGER;
};

const oldestFirst = (a, b) =>
  rowAge(a) - rowAge(b) || String(a.id).localeCompare(String(b.id));

/**
 * The plan. Pure: no I/O, no clock but `now`, no keys anywhere in its input
 * or output.
 *
 * @param input.people [{ oid, displayName, walletId, walletIssue, lightningAddress? }]
 * @param input.payLinks { [walletId]: link | null } (absent: unreadable)
 * @param input.allowances every schedule the Fund key(s) can see
 * @param input.fund { configured, wallets: [{ id, name, balanceSats }] }
 * @param input.state the sync store (byPerson: what Zaplie last wrote)
 * @param input.peopleComplete false when the people directory is provably
 *   short of its announced total: nobody missing from it is a leaver then
 * @param input.allowMassDelete the admin's explicit consent to delete more
 *   leavers than the mass-delete guard allows
 */
const planAllowanceSync = ({
  people,
  peopleComplete = true,
  allowMassDelete = false,
  payLinks = {},
  allowances,
  fund,
  policy,
  state = { byPerson: {} },
  now = new Date(),
  publicHost,
  overwriteDrift = false,
  perWalletLimit = DEFAULT_PER_WALLET_LIMIT,
  maxPeople = DEFAULT_MAX_PEOPLE,
}) => {
  const enabled = isPolicyActive(policy);
  const overwrite = overwriteDrift || policy.overwriteDrift === true;
  const excluded = new Set(policy.excludedOids || []);
  const fundWallets = fund?.configured ? fund.wallets || [] : [];
  const fundIds = new Set(fundWallets.map((wallet) => wallet.id));
  const actions = [];
  const warnings = [];
  const blockers = [];
  const byPerson = state?.byPerson || {};

  // Every schedule on a Fund wallet counts toward its limit, Zaplie's or not.
  const walletCounts = new Map(fundWallets.map((wallet) => [wallet.id, 0]));
  const seen = new Set();
  const rows = [];
  for (const row of allowances || []) {
    if (!row || typeof row.id !== 'string' || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    if (walletCounts.has(row.wallet)) {
      walletCounts.set(row.wallet, walletCounts.get(row.wallet) + 1);
    }
  }

  // Zaplie's rows, grouped by person; anything else on the wallet is ignored.
  const rowsByOid = new Map();
  for (const row of rows) {
    const oid = oidFromName(row.name);
    if (!oid) continue;
    if (!rowsByOid.has(oid)) rowsByOid.set(oid, []);
    rowsByOid.get(oid).push(row);
  }

  let activeLoad = 0;
  const loadByWallet = new Map();
  const addLoad = (walletId, sats) => {
    if (!sats) return;
    activeLoad += sats;
    loadByWallet.set(walletId, (loadByWallet.get(walletId) || 0) + sats);
  };
  const keepLoad = (row) => {
    if (row.active !== false) addLoad(row.wallet, Number(row.amount) || 0);
  };
  const rowRef = (row) => ({
    allowanceId: row.id,
    fundWalletId: row.wallet,
    revision: row.revision,
  });

  // Duplicates: the oldest schedule stays, the rest go (paused while disabled).
  const primaryByOid = new Map();
  for (const [oid, list] of rowsByOid) {
    const sorted = [...list].sort(oldestFirst);
    primaryByOid.set(oid, sorted[0]);
    for (const extra of sorted.slice(1)) {
      if (!fundIds.has(extra.wallet)) {
        actions.push({ kind: 'skip', oid, reason: 'unmanaged-fund-wallet', ...rowRef(extra) });
        keepLoad(extra);
      } else if (enabled && isInFlight(extra)) {
        // Deleting it would drop the claim the extension is reconciling.
        actions.push({ kind: 'defer', oid, reason: 'payment-in-flight', ...rowRef(extra) });
        keepLoad(extra);
      } else if (enabled) {
        actions.push({ kind: 'delete', oid, reason: 'duplicate', ...rowRef(extra) });
        walletCounts.set(extra.wallet, walletCounts.get(extra.wallet) - 1);
      } else if (extra.active !== false) {
        actions.push({
          kind: 'update',
          oid,
          reason: 'policy-disabled',
          patch: { active: false },
          ...rowRef(extra),
        });
      }
    }
  }

  const peopleByOid = new Map();
  for (const person of people || []) {
    if (person && OID_PATTERN.test(person.oid || '')) {
      peopleByOid.set(person.oid, person);
    }
  }
  const inScope = [...peopleByOid.values()].filter((person) => !excluded.has(person.oid));

  // Leavers: schedules for nobody in scope (gone from LNbits, or excluded).
  let leaverDeletes = 0;
  let incompleteLeavers = 0;
  for (const [oid, row] of primaryByOid) {
    const person = peopleByOid.get(oid);
    if (person && !excluded.has(oid)) continue;
    const reason = person ? 'excluded' : 'leaver';
    if (!fundIds.has(row.wallet)) {
      actions.push({ kind: 'skip', oid, reason: 'unmanaged-fund-wallet', ...rowRef(row) });
      keepLoad(row);
      continue;
    }
    if (!enabled) {
      if (row.active !== false) {
        actions.push({
          kind: 'update',
          oid,
          reason: 'policy-disabled',
          patch: { active: false },
          ...rowRef(row),
        });
      } else {
        actions.push({ kind: 'noop', oid, reason, ...rowRef(row) });
      }
      continue;
    }
    if (reason === 'leaver' && peopleComplete === false) {
      // Missing from a list that is short of its total is not proof of leaving.
      actions.push({ kind: 'defer', oid, reason: 'people-incomplete', ...rowRef(row) });
      keepLoad(row);
      incompleteLeavers += 1;
      continue;
    }
    if (isInFlight(row)) {
      actions.push({ kind: 'defer', oid, reason: 'payment-in-flight', ...rowRef(row) });
      keepLoad(row);
      continue;
    }
    const last = byPerson[oid]?.written;
    if (last && !sameSnapshot(snapshotOf(row), last) && !overwrite) {
      actions.push({ kind: 'drift', oid, reason: `${reason}-edited`, ...rowRef(row) });
      keepLoad(row);
      continue;
    }
    actions.push({ kind: 'delete', oid, reason, ...rowRef(row) });
    walletCounts.set(row.wallet, walletCounts.get(row.wallet) - 1);
    if (reason === 'leaver') leaverDeletes += 1;
  }

  if (incompleteLeavers > 0) {
    blockers.push({
      code: 'people-incomplete',
      message: `LNbits returned fewer users than it announced; ${incompleteLeavers} schedule(s) would look like leavers, so nothing is deleted`,
    });
  }
  const massDeleteLimit = Math.max(
    MASS_DELETE_MIN,
    Math.floor(primaryByOid.size * MASS_DELETE_SHARE),
  );
  if (leaverDeletes > massDeleteLimit && !allowMassDelete) {
    blockers.push({
      code: 'mass-delete',
      message: `${leaverDeletes} leaver schedules would be deleted, more than ${massDeleteLimit} (max of ${MASS_DELETE_MIN} and 10% of ${primaryByOid.size}); check the people directory, or confirm with allowMassDelete`,
    });
  }

  if (enabled && inScope.length > maxPeople) {
    blockers.push({
      code: 'too-many-people',
      message: `${inScope.length} people exceed ALLOWANCE_MAX_PEOPLE (${maxPeople})`,
    });
  }
  if (enabled && !publicHost) {
    blockers.push({
      code: 'no-public-host',
      message: 'LNBITS_PUBLIC_HOST (or LNBITS_NODE_URL) is needed for Lightning addresses',
    });
  }
  if (inScope.length === 0 && primaryByOid.size > 0 && enabled) {
    blockers.push({
      code: 'no-people',
      message: 'LNbits returned nobody while schedules exist; refusing to delete them all',
    });
  }

  const range = enabled ? payLinkRange(policy) : null;
  // The start shown in the preview. applyPlan recomputes it from `anchor`
  // when each create is sent, so a slow run never sends a start the extension
  // would refuse as less than a minute ahead.
  const startIso = enabled ? nextAnchor(policy, now).toISOString() : null;
  const anchor = enabled
    ? {
        period: policy.period,
        anchorWeekday: policy.anchorWeekday,
        anchorDay: policy.anchorDay,
        anchorTime: policy.anchorTime,
        timezone: policy.timezone,
      }
    : null;
  const memo = enabled ? managedMemo(policy) : null;

  const pickFundWallet = () => {
    for (const wallet of fundWallets) {
      if (walletCounts.get(wallet.id) < perWalletLimit) {
        walletCounts.set(wallet.id, walletCounts.get(wallet.id) + 1);
        return wallet.id;
      }
    }
    return null;
  };

  for (const person of inScope.sort((a, b) => a.oid.localeCompare(b.oid))) {
    const { oid, displayName } = person;
    const row = primaryByOid.get(oid) || null;
    const base = { oid, displayName };

    if (!enabled) {
      if (row && fundIds.has(row.wallet) && row.active !== false) {
        actions.push({
          ...base,
          kind: 'update',
          reason: 'policy-disabled',
          patch: { active: false },
          ...rowRef(row),
        });
      } else if (row) {
        actions.push({ ...base, kind: 'noop', reason: 'paused', ...rowRef(row) });
      }
      continue;
    }

    if (!person.walletId) {
      actions.push({ ...base, kind: 'skip', reason: person.walletIssue || 'missing-wallet' });
      if (row) keepLoad(row);
      continue;
    }

    // A recorded address (the directory) needs no pay-link management.
    const link = person.lightningAddress ? 'recorded' : payLinks[person.walletId];
    if (link === undefined) {
      actions.push({ ...base, kind: 'skip', reason: 'pay-link-unreadable' });
      if (row) keepLoad(row);
      continue;
    }
    const wantedLink = desiredPayLink({ oid, displayName, range });
    if (link === 'recorded') {
      // Nothing to do: the operator created the pay link in LNbits.
    } else if (link === null) {
      actions.push({
        ...base,
        kind: 'paylink-create',
        walletId: person.walletId,
        body: wantedLink,
      });
    } else if (payLinkDiff(link, wantedLink).length > 0) {
      actions.push({
        ...base,
        kind: 'paylink-update',
        walletId: person.walletId,
        linkId: link.id,
        fields: payLinkDiff(link, wantedLink),
        body: updateBody(link, wantedLink),
      });
    }

    const desired = {
      name: scheduleName(oid),
      lightning_address: person.lightningAddress || `${allowanceUsername(oid)}@${publicHost}`,
      amount: policy.amountSats,
      currency: 'sats',
      memo,
      active: true,
    };
    const createBody = {
      ...desired,
      frequency_type: policy.period,
      start_datetime: startIso,
      timezone_name: policy.timezone,
    };

    if (!row) {
      if (!fund?.configured) {
        actions.push({ ...base, kind: 'skip', reason: 'fund-not-configured' });
        continue;
      }
      const fundWalletId = pickFundWallet();
      if (!fundWalletId) {
        actions.push({ ...base, kind: 'skip', reason: 'fund-full' });
        continue;
      }
      actions.push({
        ...base,
        kind: 'create',
        fundWalletId,
        body: createBody,
        anchor,
        amountSats: policy.amountSats,
      });
      addLoad(fundWalletId, policy.amountSats);
      continue;
    }

    if (!fundIds.has(row.wallet)) {
      actions.push({ ...base, kind: 'skip', reason: 'unmanaged-fund-wallet', ...rowRef(row) });
      keepLoad(row);
      continue;
    }
    if (isInFlight(row)) {
      actions.push({ ...base, kind: 'defer', reason: 'payment-in-flight', ...rowRef(row) });
      keepLoad(row);
      continue;
    }

    const current = snapshotOf(row);
    const changed = MUTABLE_FIELDS.filter((field) => current[field] !== desired[field]);
    const scheduleOk =
      row.frequency_type === policy.period &&
      row.timezone_name === policy.timezone &&
      startMatchesAnchor(row.start_datetime, policy);
    if (changed.length === 0 && scheduleOk && row.name === desired.name) {
      actions.push({ ...base, kind: 'noop', ...rowRef(row), snapshot: current });
      keepLoad(row);
      continue;
    }

    // Changed by someone other than Zaplie since Zaplie last wrote it. The
    // store is a cache: with no record of this row (a lost store, or a run
    // from another machine) a row still carrying Zaplie's memo tag is taken
    // as Zaplie's; one without it is drift.
    const last = byPerson[oid]?.allowanceId === row.id ? byPerson[oid]?.written : null;
    // A paused row with no record stays paused: only the admin's overwrite
    // reactivates it.
    const handEdited = last
      ? !sameSnapshot(current, last)
      : current.active === false || !String(row.memo || '').endsWith(MANAGED_TAG);
    if (handEdited && !overwrite) {
      const paused = current.active === false && changed.length === 1;
      actions.push({
        ...base,
        kind: paused ? 'paused' : 'drift',
        reason: paused ? 'paused-by-hand' : last ? 'edited-by-hand' : 'not-written-by-zaplie',
        fields: [...changed, ...(scheduleOk ? [] : ['schedule'])],
        ...rowRef(row),
      });
      keepLoad(row);
      continue;
    }

    // Reactivating keeps the row's next_payment_date, and the extension pays
    // as soon as an active row is at or past it (tasks.py process_allowance;
    // crud.update_allowance never moves it). A row paused across an anchor
    // would pay at once, then again on the next anchor. Recreate it from the
    // next anchor instead. An unreadable date is treated as due.
    const reactivating = current.active === false && desired.active === true;
    const dueAt = Date.parse(row.next_payment_date);
    const overdue =
      reactivating && !(Number.isFinite(dueAt) && dueAt > now.getTime() + MIN_LEAD_MS);

    if (!scheduleOk || overdue) {
      // Wallet, start, frequency and time zone cannot change in place.
      actions.push({
        ...base,
        kind: 'recreate',
        reason: scheduleOk ? 'reactivate-overdue' : 'schedule-changed',
        body: createBody,
        anchor,
        amountSats: policy.amountSats,
        ...rowRef(row),
      });
      addLoad(row.wallet, policy.amountSats);
      continue;
    }

    const patch = {};
    for (const field of changed) patch[field] = desired[field];
    if (row.name !== desired.name) patch.name = desired.name;
    actions.push({
      ...base,
      kind: 'update',
      reason: 'policy-changed',
      fields: Object.keys(patch),
      patch,
      ...rowRef(row),
    });
    addLoad(row.wallet, policy.amountSats);
  }

  if (enabled && fund?.configured) {
    for (const wallet of fundWallets) {
      const load = loadByWallet.get(wallet.id) || 0;
      if (load === 0) continue;
      if (!Number.isFinite(wallet.balanceSats)) {
        blockers.push({
          code: 'fund-balance-unknown',
          message: `the balance of Fund wallet ${wallet.name || wallet.id} could not be read`,
        });
      } else if (wallet.balanceSats < load) {
        blockers.push({
          code: 'underfunded',
          overridable: true,
          message: `Fund wallet ${wallet.name || wallet.id} holds ${wallet.balanceSats} sats, less than one period (${load} sats)`,
        });
      } else if (wallet.balanceSats < 2 * load) {
        warnings.push({
          code: 'low-fund',
          message: `Fund wallet ${wallet.name || wallet.id} holds less than two periods (${2 * load} sats)`,
        });
      }
    }
  }
  if (enabled && !fund?.configured) {
    warnings.push({
      code: 'fund-not-configured',
      message: 'ALLOWANCE_FUND_ADMINKEY is not set: only pay links can be planned',
    });
  }

  const count = (kind) => actions.filter((action) => action.kind === kind).length;
  const summary = {
    policyEnabled: enabled,
    fundConfigured: Boolean(fund?.configured),
    people: inScope.length,
    paylinkCreates: count('paylink-create'),
    paylinkUpdates: count('paylink-update'),
    creates: count('create'),
    updates: count('update'),
    recreates: count('recreate'),
    deletes: count('delete'),
    noop: count('noop'),
    drift: count('drift'),
    paused: count('paused'),
    deferred: count('defer'),
    skipped: count('skip'),
    changes: actions.filter((action) => EXECUTABLE.has(action.kind)).length,
    amountSats: enabled ? policy.amountSats : null,
    totalPerPeriodSats: activeLoad,
    fundBalanceSats: fundWallets.reduce(
      (sum, wallet) => (Number.isFinite(wallet.balanceSats) ? sum + wallet.balanceSats : sum),
      0,
    ),
    nextStart: startIso,
  };
  return { actions, summary, warnings, blockers };
};

const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

// Auth failures and network trouble stop the whole run; a refusal about one
// person's schedule is recorded and the run carries on.
const isSystemic = (error) => {
  const status = error?.upstreamStatus;
  if (status === 401 || status === 403) return true;
  if (status === undefined) return true;
  return false;
};

const isLimitError = (error) =>
  error?.upstreamStatus === 422 && /maximum|limit/i.test(error?.upstreamDetail || '');

const errorText = (error) => {
  const status = error?.upstreamStatus ? ` (${error.upstreamStatus})` : '';
  const detail = error?.upstreamDetail ? `: ${error.upstreamDetail}` : '';
  return `${String(error?.message || 'error').slice(0, 200)}${status}${detail}`;
};

/**
 * Applies a plan's executable actions. `deps.clients` maps a Fund wallet id to
 * its extension client; `deps.wallets` maps an Allowance wallet id to the
 * wallet with keys (server memory only). Returns one result per action.
 */
const applyPlan = async (
  plan,
  {
    clients,
    fundOrder = [...clients.keys()],
    wallets,
    createLink = noWalletKeys,
    updateLink = noWalletKeys,
    concurrency = DEFAULT_CONCURRENCY,
    now = () => new Date(),
  },
) => {
  const results = [];
  let aborted = null;
  const full = new Set();

  // A pay link is written with the person's own wallet key, so a 401/403 there
  // is about that person (for example LNURLp not enabled for their LNbits
  // user), not the run's credentials. Only network trouble stops the run.
  const run = async (action, step, { personKey = false } = {}) => {
    if (aborted) {
      results.push({ action, ok: false, error: 'aborted' });
      return false;
    }
    try {
      const outcome = await step();
      results.push({ action, ok: true, ...outcome });
      return true;
    } catch (error) {
      const systemic = personKey ? error?.upstreamStatus === undefined : isSystemic(error);
      if (systemic) aborted = errorText(error);
      results.push({ action, ok: false, error: errorText(error), status: error?.upstreamStatus });
      return false;
    }
  };

  const conflict = async (action, client, error) => {
    if (error?.upstreamStatus !== 409) throw error;
    let row = null;
    try {
      row = await client.getAllowance(action.allowanceId);
    } catch (_readError) {
      row = null;
    }
    return { drift: true, row, note: 'changed while syncing; reported, not retried' };
  };

  // The start is computed when the request is sent, not when the plan was
  // made: gathering, the deletes and LNbits back-off can outlast the lead.
  const bodyAtSend = (action) =>
    action.anchor
      ? { ...action.body, start_datetime: nextAnchor(action.anchor, now()).toISOString() }
      : action.body;

  const createOn = async (action) => {
    const order = [action.fundWalletId, ...fundOrder.filter((id) => id !== action.fundWalletId)];
    let lastError = null;
    for (const walletId of order) {
      if (full.has(walletId) || !clients.has(walletId)) continue;
      try {
        const row = await clients.get(walletId).createAllowance(bodyAtSend(action));
        return { row, fundWalletId: walletId };
      } catch (error) {
        if (!isLimitError(error)) throw error;
        full.add(walletId);
        lastError = error;
      }
    }
    const error = new Error('every Fund wallet is at the extension limit');
    error.upstreamStatus = 422;
    error.upstreamDetail = lastError?.upstreamDetail || 'fund-full';
    throw error;
  };

  const deletes = plan.actions.filter((action) => action.kind === 'delete');
  await mapLimit(deletes, concurrency, (action) =>
    run(action, async () => {
      await clients.get(action.fundWalletId).deleteAllowance(action.allowanceId);
      return {};
    }),
  );

  const perPerson = new Map();
  for (const action of plan.actions) {
    if (!EXECUTABLE.has(action.kind) || action.kind === 'delete') continue;
    const key = action.oid || action.allowanceId;
    if (!perPerson.has(key)) perPerson.set(key, []);
    perPerson.get(key).push(action);
  }

  await mapLimit([...perPerson.values()], concurrency, async (list) => {
    for (const action of list) {
      let ok;
      if (action.kind === 'paylink-create' || action.kind === 'paylink-update') {
        const wallet = wallets.get(action.walletId);
        ok = await run(action, async () => {
          if (!wallet) throw Object.assign(new Error('wallet keys unavailable'), { upstreamStatus: 404 });
          const link =
            action.kind === 'paylink-create'
              ? await createLink(wallet, action.body)
              : await updateLink(wallet, action.linkId, action.body);
          return { linkId: link?.id || action.linkId || null };
        }, { personKey: true });
      } else if (action.kind === 'create') {
        ok = await run(action, () => createOn(action));
      } else if (action.kind === 'update') {
        const client = clients.get(action.fundWalletId);
        ok = await run(action, async () => {
          try {
            return {
              row: await client.updateAllowance(action.allowanceId, action.revision, action.patch),
            };
          } catch (error) {
            return conflict(action, client, error);
          }
        });
      } else if (action.kind === 'recreate') {
        const client = clients.get(action.fundWalletId);
        ok = await run(action, async () => {
          await client.deleteAllowance(action.allowanceId);
          return createOn(action);
        });
      }
      // A failed pay link leaves the schedule alone: it would pay an address
      // that does not exist yet.
      if (!ok) break;
    }
  });

  return { results, aborted };
};

// --- gather and run --------------------------------------------------------

const ALLOWANCE_WALLET = 'allowance';

/** Directory entries keyed by Entra object id (gateway listDirectoryUsers). */
const peopleFromUsers = (users) => {
  const byOid = new Map();
  for (const user of users) {
    const extra = user?.extra && typeof user.extra === 'object' ? user.extra : {};
    const candidate = user?.external_id;
    if (typeof candidate !== 'string') continue;
    const oid = candidate.toLowerCase();
    if (!OID_PATTERN.test(oid)) continue;
    const displayName = String(extra.display_name || user?.username || oid).slice(0, 100);
    if (byOid.has(oid)) {
      byOid.get(oid).duplicate = true;
      continue;
    }
    byOid.set(oid, { oid, displayName, userId: user.id });
  }
  return [...byOid.values()];
};

// The same rule as positiveIntFromEnv (decimal digits only, malformed throws
// rather than widening a limit), over an injectable environment.
const envInt = (env, name, fallback) => {
  const configured = env[name];
  if (configured === undefined || String(configured).trim() === '') {
    return fallback;
  }
  const trimmed = String(configured).trim();
  const value = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AllowanceSyncError(`${name} must be a positive integer`, 500, 'bad-setting');
  }
  return value;
};

/**
 * Reads everything the planner needs. Keys stay in the returned `wallets`
 * and `clients` maps, which never leave this module's callers.
 */
const gatherSnapshot = async ({
  policy,
  env = process.env,
  concurrency = DEFAULT_CONCURRENCY,
  listUsers = listDirectoryUsers,
  listWallets = listPersonWallets,
  listLinks = null,
  clientFactory = createAllowanceExtensionClient,
}) => {
  const keys = readFundKeys(env);
  const clients = new Map();
  const fundOrder = [];
  const fundWallets = [];
  let allowances = [];
  let health = null;
  for (const key of keys) {
    const client = clientFactory(key);
    const info = await client.fundWallet();
    if (!info.id) {
      throw new AllowanceSyncError('the Fund wallet did not report its id', 502, 'fund-unreadable');
    }
    if (RESERVED_FUND_NAMES.has(String(info.name).trim().toLowerCase())) {
      throw new AllowanceSyncError(
        `the Fund wallet must not be named "${info.name}": that name is a person's wallet`,
        500,
        'fund-misconfigured',
      );
    }
    if (clients.has(info.id)) continue;
    clients.set(info.id, client);
    fundOrder.push(info.id);
    fundWallets.push(info);
  }
  if (clients.size > 0) {
    const lists = await mapLimit([...clients.values()], concurrency, (client) =>
      client.listAllowances(),
    );
    allowances = lists.flat();
    try {
      health = await clients.get(fundOrder[0]).health();
    } catch (_error) {
      health = null;
    }
  }

  // { users, total, complete } from the paged reader. A paged list is complete
  // only when the pages add up to the announced total (or an empty page ended
  // an unannounced list). A bare array is an unpaged server's whole list and is
  // trusted as complete. Anything short of complete cannot prove who has left.
  const listed = await listUsers();
  const users = listed?.users;
  if (!Array.isArray(users)) {
    throw new AllowanceSyncError('the people directory is malformed', 502, 'users-unreadable');
  }
  const announced = Number.isSafeInteger(listed.total) ? listed.total : null;
  const peopleComplete =
    listed.complete === true && (announced === null || users.length >= announced);
  const people = peopleFromUsers(users);
  const wallets = new Map();
  const payLinks = {};
  const fundIds = new Set(fundOrder);
  const enabled = isPolicyActive(policy);
  await mapLimit(people, concurrency, async (person) => {
    if (person.duplicate) {
      person.walletIssue = 'duplicate-lnbits-user';
      return;
    }
    let list;
    try {
      list = await listWallets(person.userId);
    } catch (error) {
      if (isSystemic(error)) throw error;
      person.walletIssue = 'wallet-unreadable';
      return;
    }
    if (list.some((wallet) => fundIds.has(wallet.id))) {
      throw new AllowanceSyncError(
        'a Fund wallet belongs to a person; use a wallet on an account with no Entra id',
        500,
        'fund-misconfigured',
      );
    }
    const matches = list.filter(
      (wallet) => String(wallet.name).trim().toLowerCase() === ALLOWANCE_WALLET,
    );
    if (matches.length !== 1) {
      person.walletIssue = matches.length === 0 ? 'missing-wallet' : 'ambiguous-wallet';
      return;
    }
    const wallet = matches[0];
    // A directory wallet carries the address its schedule pays; the
    // allowance extension needs nothing else.
    if (wallet.lightningAddress !== undefined) {
      if (!wallet.lightningAddress) {
        person.walletIssue = 'missing-lightning-address';
        return;
      }
      person.walletId = wallet.id;
      person.lightningAddress = wallet.lightningAddress;
      return;
    }
    person.walletId = wallet.id;
    wallets.set(wallet.id, wallet);
    if (!enabled || !listLinks) return;
    try {
      payLinks[wallet.id] = findAllowancePayLink(await listLinks(wallet), person.oid);
    } catch (error) {
      // The person's own key: a refusal is theirs (the person is skipped);
      // only network trouble is the run's.
      if (error?.upstreamStatus === undefined) throw error;
    }
  });

  return {
    snapshot: {
      people: people.map(({ oid, displayName, walletId, walletIssue, lightningAddress }) => ({
        oid,
        displayName,
        walletId: walletId || null,
        walletIssue: walletIssue || null,
        ...(lightningAddress ? { lightningAddress } : {}),
      })),
      peopleComplete,
      payLinks,
      allowances,
      fund: { configured: clients.size > 0, wallets: fundWallets },
      health,
    },
    clients,
    fundOrder,
    wallets,
  };
};

/** The planner's view of an action, for previews, logs and the audit: no keys, no bodies. */
const publicAction = (action) => {
  const view = {
    kind: action.kind,
    oid: action.oid || null,
    displayName: action.displayName || null,
    reason: action.reason || null,
    allowanceId: action.allowanceId || null,
    fundWalletId: action.fundWalletId || null,
  };
  if (action.fields) view.fields = action.fields;
  if (action.patch) view.patch = action.patch;
  if (action.amountSats) view.amountSats = action.amountSats;
  if (action.body?.lightning_address) view.lightningAddress = action.body.lightning_address;
  if (action.body?.start_datetime) view.startDatetime = action.body.start_datetime;
  if (action.body?.username && !action.body.lightning_address) view.username = action.body.username;
  return view;
};

let running = false;

const isSyncRunning = () => running;

/**
 * One sync. `mode` 'dry' only plans. 'apply' also changes LNbits, after the
 * checks: the Fund is configured, nothing blocks, and `confirmTotalSats`
 * equals the plan's total per period.
 */
const runAllowanceSync = async (
  {
    mode = 'dry',
    confirmTotalSats,
    overwriteDrift = false,
    allowUnderfunded = false,
    allowMassDelete = false,
    by = 'unknown',
  } = {},
  {
    readData,
    store,
    env = process.env,
    now = () => new Date(),
    gather = gatherSnapshot,
    apply = applyPlan,
  } = {},
) => {
  if (mode !== 'dry' && mode !== 'apply') {
    throw new AllowanceSyncError("mode must be 'dry' or 'apply'", 400, 'bad-mode');
  }
  if (running) {
    throw new AllowanceSyncError('an allowance sync is already running', 409, 'busy');
  }
  // `running` covers this process; the lock file covers the CLI and the
  // portal (and its timer) running at once, which could both plan "no row"
  // for a new person and both create one.
  const lock = store.acquireLock();
  if (!lock.acquired) {
    const holder = lock.holder || {};
    const where = holder.pid
      ? ` (pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''} since ${holder.at || 'unknown'})`
      : '';
    throw new AllowanceSyncError(
      `another allowance sync is already running${where}; try again when it finishes. ` +
        `A lock older than 30 minutes is taken over: ${store.lockPath}`,
      409,
      'busy',
    );
  }
  running = true;
  try {
    let policy;
    try {
      policy = readAllowancePolicy(readData());
    } catch (error) {
      throw new AllowanceSyncError(
        `the stored allowance policy is invalid: ${error.message}`,
        500,
        'policy-invalid',
      );
    }
    if (mode === 'apply' && readFundKeys(env).length === 0) {
      throw new AllowanceSyncError(
        'ALLOWANCE_FUND_ADMINKEY is not configured',
        503,
        'fund-not-configured',
      );
    }
    const concurrency = envInt(env, 'ALLOWANCE_SYNC_CONCURRENCY', DEFAULT_CONCURRENCY);
    const startedAt = now();
    const gathered = await gather({ policy, env, concurrency });
    const state = store.read();
    const plan = planAllowanceSync({
      ...gathered.snapshot,
      policy,
      state,
      now: startedAt,
      publicHost: publicLnbitsHost(env),
      overwriteDrift,
      allowMassDelete,
      perWalletLimit: envInt(env, 'ALLOWANCE_PER_WALLET_LIMIT', DEFAULT_PER_WALLET_LIMIT),
      maxPeople: envInt(env, 'ALLOWANCE_MAX_PEOPLE', DEFAULT_MAX_PEOPLE),
    });
    const preview = {
      mode,
      at: startedAt.toISOString(),
      by,
      summary: plan.summary,
      warnings: plan.warnings,
      blockers: plan.blockers,
      health: gathered.snapshot.health,
      fund: gathered.snapshot.fund.wallets.map(({ id, name, balanceSats }) => ({
        id,
        name,
        balanceSats,
      })),
      actions: plan.actions.map(publicAction),
    };
    if (mode === 'dry') {
      return preview;
    }

    const hard = plan.blockers.filter(
      (blocker) => !(blocker.overridable && allowUnderfunded),
    );
    if (hard.length > 0) {
      throw new AllowanceSyncError(
        `apply refused: ${hard.map((blocker) => blocker.message).join('; ')}`,
        409,
        hard[0].code,
      );
    }
    if (
      !Number.isSafeInteger(confirmTotalSats) ||
      confirmTotalSats !== plan.summary.totalPerPeriodSats
    ) {
      throw new AllowanceSyncError(
        'confirmTotalSats does not match the plan: preview again and confirm its total per period',
        409,
        'confirm-mismatch',
      );
    }

    const { results, aborted } = await apply(plan, {
      clients: gathered.clients,
      fundOrder: gathered.fundOrder,
      wallets: gathered.wallets,
      concurrency,
      now,
    });

    const finishedAt = now();
    const audit = [];
    const nextState = { ...state, byPerson: { ...state.byPerson } };
    const tally = { created: 0, updated: 0, deleted: 0, payLinks: 0, drift: 0, errors: 0 };
    for (const result of results) {
      const { action } = result;
      const oid = action.oid;
      const record = oid ? { ...(nextState.byPerson[oid] || {}) } : null;
      if (!result.ok) {
        tally.errors += 1;
        if (record) {
          record.state = 'error';
          record.lastError = result.error;
          record.lastSyncedAt = finishedAt.toISOString();
          nextState.byPerson[oid] = record;
        }
      } else if (result.drift) {
        tally.drift += 1;
        if (record) {
          record.state = 'drift';
          record.lastError = result.note;
          nextState.byPerson[oid] = record;
        }
      } else {
        if (action.kind === 'delete') tally.deleted += 1;
        if (action.kind === 'create' || action.kind === 'recreate') tally.created += 1;
        if (action.kind === 'update') tally.updated += 1;
        if (action.kind.startsWith('paylink')) tally.payLinks += 1;
        if (record) {
          if (action.kind.startsWith('paylink')) {
            record.walletId = action.walletId;
            record.payLinkId = result.linkId;
            record.lightningAddress = `${allowanceUsername(oid)}@${publicLnbitsHost(env)}`;
          } else if (action.kind === 'delete') {
            if (record.allowanceId === action.allowanceId) {
              delete record.allowanceId;
              delete record.written;
              delete record.revision;
            }
          } else if (result.row) {
            record.allowanceId = result.row.id;
            record.fundWalletId = result.fundWalletId || action.fundWalletId;
            record.revision = result.row.revision;
            record.written = snapshotOf(result.row);
          }
          record.state = 'ok';
          record.lastError = null;
          record.lastSyncedAt = finishedAt.toISOString();
          nextState.byPerson[oid] = record;
        }
      }
      audit.push({
        at: finishedAt.toISOString(),
        by,
        action: action.kind,
        oid: oid || null,
        allowanceId: result.row?.id || action.allowanceId || null,
        before: action.allowanceId ? { revision: action.revision ?? null } : null,
        after: result.ok ? snapshotOf(result.row) : null,
        reason: action.reason || null,
        ok: result.ok,
        error: result.ok ? null : result.error,
      });
    }
    // A noop proves the row matches the policy, so it is what Zaplie wrote.
    for (const action of plan.actions) {
      if (action.kind === 'noop' && action.snapshot && action.oid) {
        nextState.byPerson[action.oid] = {
          ...(nextState.byPerson[action.oid] || {}),
          allowanceId: action.allowanceId,
          fundWalletId: action.fundWalletId,
          revision: action.revision,
          written: action.snapshot,
          state: 'ok',
          lastSyncedAt: finishedAt.toISOString(),
        };
      }
    }
    const runSummary = {
      mode,
      at: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      by,
      planned: plan.summary,
      ...tally,
      aborted,
      totalPerPeriodSats: plan.summary.totalPerPeriodSats,
    };
    nextState.lastRun = runSummary;
    nextState.runs = [...(state.runs || []), runSummary];
    // The timer only maintains a policy a person (an admin or the CLI) has
    // applied with a confirmed total; a changed policy waits for them.
    if (by !== TIMER_ACTOR && !aborted) {
      nextState.lastAdminApply = {
        policyUpdatedAt: policy.updatedAt,
        totalPerPeriodSats: plan.summary.totalPerPeriodSats,
        at: finishedAt.toISOString(),
        by,
      };
    }
    store.write(nextState);
    store.appendAudit(audit);
    return { ...preview, result: runSummary, errors: results.filter((r) => !r.ok).map((r) => ({ ...publicAction(r.action), error: r.error })) };
  } finally {
    running = false;
    lock.release();
  }
};

module.exports = {
  AllowanceSyncError,
  MANAGED_TAG,
  NAME_PREFIX,
  TIMER_ACTOR,
  applyPlan,
  gatherSnapshot,
  isSyncRunning,
  managedMemo,
  mapLimit,
  peopleFromUsers,
  planAllowanceSync,
  publicAction,
  runAllowanceSync,
  scheduleName,
  snapshotOf,
};
