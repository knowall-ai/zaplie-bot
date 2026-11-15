#!/usr/bin/env node
// Weekly allowance sync from the command line, the same run as the
// Automations panel's preview/apply, for operators without the portal or for
// scripting.
//
//   node backend/scripts/allowance-sync.js                 # preview, changes nothing
//   node backend/scripts/allowance-sync.js --apply --confirm-total <sats>
//
// Run from tabs/, with the portal backend's environment (LNBITS_URL,
// ALLOWANCE_FUND_ADMINKEY, ZAPLIE_DATA_DIR and ZAPLIE_STORE_KEY, which opens
// the people directory the Allowance wallet keys live in).
// The policy comes from data.json (allowancePolicy). It prints no key.
const fs = require('fs');
const { dataPath } = require('../dataPaths');
const { runAllowanceSync } = require('../allowanceSync');
const { createAllowanceSyncStore } = require('../allowanceSyncStore');
const { applyAllowancePolicyPatch, readAllowancePolicy } = require('../allowancePolicy');
const { writeJsonSecure } = require('../secureJsonStore');

const USAGE = `Usage: node backend/scripts/allowance-sync.js [options]

  (no options)            preview the sync; nothing in LNbits changes
  --apply                 apply the plan (needs --confirm-total)
  --confirm-total <sats>  the preview's "total per period", echoed back
  --overwrite-drift       also overwrite schedules someone edited by hand
  --allow-underfunded     apply even if a Fund wallet holds less than one period
  --allow-mass-delete     apply even if more than max(5, 10%) of the schedules
                          would be deleted as leavers
  --json                  print the full result as JSON
  --show-policy           print the stored allowance policy and exit
  --set-policy <file>     validate a policy JSON file, store it in data.json and exit
                          (each key in the file replaces the stored one; no LNbits call)
  --help                  this text
`;

const parseArgs = (argv) => {
  const options = {
    mode: 'dry',
    json: false,
    overwriteDrift: false,
    allowUnderfunded: false,
    allowMassDelete: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--show-policy') options.showPolicy = true;
    else if (arg === '--set-policy') {
      options.setPolicy = argv[index + 1];
      index += 1;
      if (!options.setPolicy) throw new Error('--set-policy needs a JSON file');
    } else if (arg === '--apply') options.mode = 'apply';
    else if (arg === '--json') options.json = true;
    else if (arg === '--overwrite-drift') options.overwriteDrift = true;
    else if (arg === '--allow-underfunded') options.allowUnderfunded = true;
    else if (arg === '--allow-mass-delete') options.allowMassDelete = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--confirm-total') {
      const value = argv[index + 1];
      index += 1;
      if (!/^\d+$/.test(value || '')) {
        throw new Error('--confirm-total needs a whole number of sats');
      }
      options.confirmTotalSats = Number.parseInt(value, 10);
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  if (options.mode === 'apply' && options.confirmTotalSats === undefined) {
    throw new Error('--apply needs --confirm-total <sats> from a preview');
  }
  return options;
};

const readDataFile = (filePath = dataPath('data.json')) => () => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
};

const pad = (value, width) => String(value ?? '').padEnd(width).slice(0, width);

const formatResult = (result) => {
  const lines = [];
  const s = result.summary;
  lines.push(`Allowance sync (${result.mode}) at ${result.at}`);
  lines.push(
    `Policy ${s.policyEnabled ? 'enabled' : 'DISABLED (schedules are paused, nothing is created)'}; ` +
      `Fund ${s.fundConfigured ? 'configured' : 'NOT configured'}`,
  );
  for (const wallet of result.fund || []) {
    lines.push(`  Fund wallet ${wallet.name} (${wallet.id}): ${wallet.balanceSats ?? 'unknown'} sats`);
  }
  if (result.health) {
    lines.push(
      `  Extension health: ${result.health.healthy ? 'healthy' : 'NOT healthy'} ` +
        `(overdue ${result.health.overdue ?? '?'}, pending ${result.health.pending ?? '?'})`,
    );
  }
  lines.push('');
  lines.push(`${pad('ACTION', 16)}${pad('PERSON', 28)}${pad('OID', 38)}DETAIL`);
  for (const action of result.actions) {
    const detail = [
      action.reason,
      action.fields ? `fields=${action.fields.join(',')}` : null,
      action.amountSats ? `${action.amountSats} sats` : null,
      action.lightningAddress,
      action.startDatetime ? `from ${action.startDatetime}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`${pad(action.kind, 16)}${pad(action.displayName, 28)}${pad(action.oid, 38)}${detail}`);
  }
  lines.push('');
  lines.push(
    `People ${s.people}; pay links +${s.paylinkCreates} ~${s.paylinkUpdates}; ` +
      `schedules +${s.creates} ~${s.updates} recreate ${s.recreates} -${s.deletes}; ` +
      `noop ${s.noop}, drift ${s.drift}, paused ${s.paused}, deferred ${s.deferred}, skipped ${s.skipped}`,
  );
  lines.push(`Changes to apply: ${s.changes}`);
  lines.push(`Total per period: ${s.totalPerPeriodSats} sats (Fund holds ${s.fundBalanceSats} sats)`);
  for (const warning of result.warnings) lines.push(`WARNING: ${warning.message}`);
  for (const blocker of result.blockers) {
    const hint = blocker.overridable
      ? ' (--allow-underfunded overrides)'
      : blocker.code === 'mass-delete'
        ? ' (--allow-mass-delete overrides)'
        : '';
    lines.push(`BLOCKED: ${blocker.message}${hint}`);
  }
  if (result.mode === 'dry') {
    lines.push('');
    lines.push(
      `Nothing was changed. To apply: node backend/scripts/allowance-sync.js --apply --confirm-total ${s.totalPerPeriodSats}`,
    );
  } else if (result.result) {
    const r = result.result;
    lines.push('');
    lines.push(
      `Applied: created ${r.created}, updated ${r.updated}, deleted ${r.deleted}, ` +
        `pay links ${r.payLinks}, drift ${r.drift}, errors ${r.errors}` +
        (r.aborted ? `; STOPPED: ${r.aborted}` : ''),
    );
    for (const error of result.errors || []) {
      lines.push(`  error ${error.kind} ${error.oid || error.allowanceId}: ${error.error}`);
    }
  }
  return lines.join('\n');
};

const main = async (
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, deps = {} } = {},
) => {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  const dataFile = deps.dataFile || dataPath('data.json');
  if (options.showPolicy || options.setPolicy) {
    try {
      const data = readDataFile(dataFile)();
      let policy = readAllowancePolicy(data);
      if (options.setPolicy) {
        const patch = JSON.parse(fs.readFileSync(options.setPolicy, 'utf8'));
        policy = applyAllowancePolicyPatch(policy, patch, { by: 'cli' });
        writeJsonSecure(dataFile, { ...data, allowancePolicy: policy });
        stdout.write(`Stored the allowance policy in ${dataFile}. Nothing in LNbits changed.\n`);
      }
      stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
      return 0;
    } catch (error) {
      stderr.write(`allowance policy not stored: ${error.message}\n`);
      return 1;
    }
  }
  try {
    const result = await runAllowanceSync(
      {
        mode: options.mode,
        confirmTotalSats: options.confirmTotalSats,
        overwriteDrift: options.overwriteDrift,
        allowUnderfunded: options.allowUnderfunded,
        allowMassDelete: options.allowMassDelete,
        by: 'cli',
      },
      {
        readData: deps.readData || readDataFile(dataFile),
        store: deps.store || createAllowanceSyncStore(),
        ...(deps.gather ? { gather: deps.gather } : {}),
        ...(deps.apply ? { apply: deps.apply } : {}),
        ...(deps.env ? { env: deps.env } : {}),
      },
    );
    stdout.write(`${options.json ? JSON.stringify(result, null, 2) : formatResult(result)}\n`);
    return result.result?.errors || result.result?.aborted ? 1 : 0;
  } catch (error) {
    if (error?.code === 'busy') {
      // Another run (the portal, its timer, or another CLI) holds the lock.
      stderr.write(`allowance sync not started: ${error.message}\n`);
      return 3;
    }
    stderr.write(`allowance sync failed: ${error.message}\n`);
    return 1;
  }
};

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { formatResult, main, parseArgs };
