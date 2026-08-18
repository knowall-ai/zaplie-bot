// Trigger contract for the weekly allowance run (POST /api/v1/allowance/topup).
//
// Operator contract: an external scheduler (Azure Logic App) POSTs this route
// once a week with the `x-api-key` header used by /api/v1/rewards. Weeks are
// ISO-8601 weeks computed in UTC, so a Monday-morning schedule in any local
// timezone lands inside the intended week. The response is JSON: `skipped`
// says whether this trigger started a run, and per-wallet counters report what
// moved.
//
// Schedulers retry, and a retry that re-runs the sweep would send the freshly
// granted allowances straight back to the treasury. Two guards prevent that:
// a persisted week record (written before the run starts, so a crash mid-run
// still blocks the week) and an in-process promise shared by concurrent
// triggers, so two simultaneous POSTs join one run instead of both sweeping.

import * as fs from 'fs';
import * as path from 'path';
import type { Request, Response } from 'express';
import {
  assertWeeklyAllowanceConfig,
  scheduledTopup,
  WeeklyAllowanceSummary,
} from './lnbitsService';
import { resolveDataDir } from './dataDir';
import { RewardError } from './rewardsService';

export interface AllowanceRunSummary {
  wallets: number;
  swept: number;
  toppedUp: number;
  failed: number;
  warned: number;
}

export interface AllowanceRunRecord {
  isoWeek: string;
  // Written before the sweep begins. A record with no `lastSuccessAt` is a run
  // that started and never reported back — the week stays blocked until an
  // operator reconciles it.
  startedAt: string;
  lastSuccessAt?: string;
  summary?: AllowanceRunSummary;
  lastErrorAt?: string;
  lastError?: string;
}

export class AllowanceGuardError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AllowanceGuardError';
  }
}

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === 'object' && error !== null && 'code' in error;

const runFilePath = (): string =>
  path.join(resolveDataDir(), 'allowance-runs.json');

// ISO-8601 week label (e.g. 2026-W34), always in UTC. The week's year can
// differ from the calendar year around January 1st, so it is derived from the
// week's Thursday.
export const isoWeekOf = (date: Date): string => {
  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

// A missing file means the guard has never been written and the run may
// proceed. Anything else — unreadable file, invalid JSON, a record we cannot
// interpret — must fail closed: treating a corrupt guard as "never ran" is how
// a second sweep gets authorised.
export const readLastRun = (): AllowanceRunRecord | null => {
  let raw: string;
  try {
    raw = fs.readFileSync(runFilePath(), 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw new AllowanceGuardError(
      'allowance run guard could not be read',
      error,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AllowanceGuardError(
      'allowance run guard is not valid JSON',
      error,
    );
  }

  const record = parsed as Partial<AllowanceRunRecord> | null;
  if (
    typeof record?.isoWeek !== 'string' ||
    record.isoWeek.length === 0 ||
    !isIsoTimestamp(record.startedAt) ||
    (record.lastSuccessAt !== undefined &&
      !isIsoTimestamp(record.lastSuccessAt))
  ) {
    throw new AllowanceGuardError('allowance run guard is invalid');
  }
  return record as AllowanceRunRecord;
};

export const recordRun = (record: AllowanceRunRecord): void => {
  const file = runFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, file);
};

// Only used when the run finished and proved that nothing moved, so the
// scheduler's retry is free to try the week again.
export const clearRun = (): void => {
  try {
    fs.unlinkSync(runFilePath());
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return;
    }
    throw new AllowanceGuardError(
      'allowance run guard could not be cleared',
      error,
    );
  }
};

export interface AllowanceTopupHandlerDependencies {
  isAuthorized: (providedKey: string) => Promise<boolean>;
  runTopup?: () => Promise<WeeklyAllowanceSummary>;
  assertConfig?: () => void;
  getLastRun?: () => AllowanceRunRecord | null;
  saveRun?: (record: AllowanceRunRecord) => void;
  clearLastRun?: () => void;
  now?: () => Date;
}

interface AllowanceRunOutcome {
  record: AllowanceRunRecord;
  summary: WeeklyAllowanceSummary;
}

const responseBody = (outcome: AllowanceRunOutcome) => ({
  skipped: false,
  wallets: outcome.summary.wallets,
  swept: outcome.summary.swept,
  toppedUp: outcome.summary.toppedUp,
  failed: outcome.summary.failures.length,
  failures: outcome.summary.failures,
  ...(outcome.summary.warnings.length > 0
    ? { warnings: outcome.summary.warnings }
    : {}),
  lastSuccessAt: outcome.record.lastSuccessAt,
  ...(outcome.record.lastError ? { lastError: outcome.record.lastError } : {}),
});

export const createAllowanceTopupHandler = ({
  isAuthorized,
  runTopup = () => scheduledTopup(),
  assertConfig = assertWeeklyAllowanceConfig,
  getLastRun = readLastRun,
  saveRun = recordRun,
  clearLastRun = clearRun,
  now = () => new Date(),
}: AllowanceTopupHandlerDependencies) => {
  // Shared by every concurrent trigger for as long as a run is in flight. The
  // persisted week record only stops sequential retries; this stops two POSTs
  // that arrive before the first one has written anything.
  let inFlight: Promise<AllowanceRunOutcome> | null = null;

  const startRun = (currentWeek: string): Promise<AllowanceRunOutcome> => {
    const run = (async (): Promise<AllowanceRunOutcome> => {
      const startedAt = now().toISOString();
      // Claim the week before touching a single wallet: if the process dies
      // mid-sweep the guard is already on disk and the week stays blocked.
      saveRun({ isoWeek: currentWeek, startedAt });

      let summary: WeeklyAllowanceSummary;
      try {
        summary = await runTopup();
      } catch (error) {
        // The run's effect is unknown, so the week guard stays: a blind retry
        // could double-sweep. Record why for the operator who reconciles it.
        saveRun({
          isoWeek: currentWeek,
          startedAt,
          lastErrorAt: now().toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const record: AllowanceRunRecord = {
        isoWeek: currentWeek,
        startedAt,
        lastSuccessAt: now().toISOString(),
        summary: {
          wallets: summary.wallets,
          swept: summary.swept,
          toppedUp: summary.toppedUp,
          failed: summary.failures.length,
          warned: summary.warnings.length,
        },
        ...(summary.failures.length > 0
          ? {
              lastErrorAt: now().toISOString(),
              lastError: summary.failures[summary.failures.length - 1].error,
            }
          : {}),
      };

      // Once any wallet was swept or topped up the week is spent: a retry
      // would double-sweep the wallets that succeeded. If the run completed
      // and proved nothing moved at all, drop the guard so the scheduler's
      // retry can try again.
      if (summary.swept > 0 || summary.toppedUp > 0 || summary.wallets === 0) {
        saveRun(record);
      } else {
        clearLastRun();
      }

      return { record, summary };
    })();

    inFlight = run;
    run
      .finally(() => {
        if (inFlight === run) {
          inFlight = null;
        }
      })
      .catch(() => undefined);
    return run;
  };

  return async (req: Request, res: Response): Promise<void> => {
    try {
      if (!(await isAuthorized(req.header('x-api-key') ?? ''))) {
        res.status(401).json({ error: 'invalid API key' });
        return;
      }
    } catch (error) {
      if (error instanceof RewardError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      console.error('allowance key validation failed:', error);
      res.status(503).json({ error: 'allowance endpoint unavailable' });
      return;
    }

    try {
      assertConfig();
    } catch (error) {
      res.status(503).json({
        error: `allowance topup not configured: ${
          error instanceof Error ? error.message : 'invalid configuration'
        }`,
      });
      return;
    }

    const currentWeek = isoWeekOf(now());

    let lastRun: AllowanceRunRecord | null;
    try {
      lastRun = getLastRun();
    } catch (error) {
      console.error('allowance run guard unreadable:', error);
      res.status(503).json({ error: 'allowance guard unavailable' });
      return;
    }

    // Covers both a completed run and one that started and never reported: in
    // either case this week's wallets must not be swept again.
    if (lastRun && lastRun.isoWeek === currentWeek) {
      res.status(200).json({ skipped: true, lastRun });
      return;
    }

    // A trigger that arrives while a run is in flight joins it rather than
    // starting a second sweep, and reports the shared run's outcome.
    const joined = inFlight !== null;
    const run = inFlight ?? startRun(currentWeek);

    try {
      const outcome = await run;
      if (joined) {
        res.status(200).json({ skipped: true, lastRun: outcome.record });
        return;
      }
      res.status(200).json(responseBody(outcome));
    } catch (error) {
      // Internals (env names, LNbits ids) must not leak to the scheduler.
      console.error('weekly allowance run failed:', error);
      res.status(500).json({ error: 'internal error' });
    }
  };
};
