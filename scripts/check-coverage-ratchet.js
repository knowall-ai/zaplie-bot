#!/usr/bin/env node
/**
 * Coverage ratchet.
 *
 * Compares the coverage produced by the latest `npm test` run
 * (coverage/coverage-summary.json) against a committed baseline
 * (.coverage-baseline.json) and enforces that coverage only ever trends up:
 *
 *   - FAILS the build if any metric drops more than TOLERANCE below baseline.
 *   - On main-branch runs, bumps the baseline upward to the new numbers and
 *     commits it back (best-effort — a failure to commit never fails the build,
 *     only a genuine coverage regression does).
 *
 * Metrics tracked: statements, branches, functions, lines (global totals).
 *
 * Usage: node scripts/check-coverage-ratchet.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUMMARY_PATH = path.join(ROOT, 'coverage', 'coverage-summary.json');
const BASELINE_PATH = path.join(ROOT, '.coverage-baseline.json');

// A metric may dip by at most this many percentage points below baseline
// before it is treated as a regression. Small enough to catch real drops,
// large enough to absorb rounding noise.
const TOLERANCE = 0.1;

const METRICS = ['statements', 'branches', 'functions', 'lines'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isMainBranch() {
  // GitHub Actions sets GITHUB_REF_NAME on both push and PR runs.
  const ref = process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || '';
  if (ref === 'main' || ref === 'refs/heads/main') return true;
  // Fall back to the local git branch when not running in CI.
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    return branch === 'main';
  } catch {
    return false;
  }
}

function main() {
  if (!fs.existsSync(SUMMARY_PATH)) {
    console.error(
      `Coverage summary not found at ${SUMMARY_PATH}. Run "npm test" (with coverage enabled) first.`,
    );
    process.exit(1);
  }

  const summary = readJson(SUMMARY_PATH).total;
  const baseline = fs.existsSync(BASELINE_PATH) ? readJson(BASELINE_PATH) : {};

  const current = {};
  for (const metric of METRICS) {
    current[metric] = summary[metric] ? summary[metric].pct : 0;
  }

  let regressed = false;
  const nextBaseline = {};

  console.log('Coverage ratchet report:');
  console.log('  metric      baseline   current');
  for (const metric of METRICS) {
    const base = typeof baseline[metric] === 'number' ? baseline[metric] : 0;
    const cur = current[metric];
    const delta = cur - base;
    const flag = delta < -TOLERANCE ? '  <-- REGRESSION' : '';
    console.log(
      `  ${metric.padEnd(11)} ${base.toFixed(2).padStart(7)}   ${cur
        .toFixed(2)
        .padStart(7)}${flag}`,
    );
    if (delta < -TOLERANCE) regressed = true;
    // The baseline only ever ratchets upward.
    nextBaseline[metric] = Math.max(base, cur);
  }

  if (regressed) {
    console.error(
      `\nCoverage regressed by more than ${TOLERANCE}%% below baseline. ` +
        'Add or restore tests to bring coverage back up.',
    );
    process.exit(1);
  }

  console.log('\nCoverage ratchet passed (no metric dropped below baseline).');

  // On main, ratchet the committed baseline upward. Best-effort only.
  const improved = METRICS.some(
    m => nextBaseline[m] > (baseline[m] || 0) + 1e-9,
  );
  if (isMainBranch() && improved) {
    try {
      fs.writeFileSync(
        BASELINE_PATH,
        JSON.stringify(nextBaseline, null, 2) + '\n',
      );
      console.log('Baseline improved — updating .coverage-baseline.json.');
      execSync('git add .coverage-baseline.json', { cwd: ROOT });
      execSync(
        'git -c user.name="github-actions[bot]" ' +
          '-c user.email="41898282+github-actions[bot]@users.noreply.github.com" ' +
          'commit -m "chore: bump coverage baseline [skip ci]"',
        { cwd: ROOT, stdio: 'inherit' },
      );
      execSync('git push', { cwd: ROOT, stdio: 'inherit' });
      console.log('Coverage baseline committed and pushed.');
    } catch (err) {
      // Never fail the build because the auto-commit-back could not complete.
      console.warn(
        `Could not commit updated baseline (non-fatal): ${err.message}`,
      );
    }
  }
}

main();
