import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Request, Response } from 'express';
import {
  AllowanceGuardError,
  AllowanceRunRecord,
  clearRun,
  createAllowanceTopupHandler,
  isoWeekOf,
  readLastRun,
  recordRun,
} from './allowanceTopup';
import { RewardError } from './rewardsService';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

const request = (apiKey?: string): Request =>
  ({
    header: (name: string) =>
      name.toLowerCase() === 'x-api-key' ? apiKey : undefined,
  }) as unknown as Request;

interface CapturedResponse {
  statusCode: number;
  body: unknown;
}

const response = (): Response & CapturedResponse => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & CapturedResponse;
};

const summary = (
  overrides: Partial<{
    wallets: number;
    swept: number;
    toppedUp: number;
    failures: { walletId: string; error: string }[];
    warnings: { walletId: string; warning: string }[];
  }> = {},
) => ({
  wallets: 2,
  swept: 1,
  toppedUp: 2,
  failures: [],
  warnings: [],
  ...overrides,
});

const passingConfig = () => undefined;

describe('isoWeekOf', () => {
  test('labels dates with their ISO week', () => {
    expect(isoWeekOf(new Date(Date.UTC(2026, 7, 18)))).toBe('2026-W34');
    // January 1st 2027 is a Friday and still belongs to 2026's last week.
    expect(isoWeekOf(new Date(Date.UTC(2027, 0, 1)))).toBe('2026-W53');
    expect(isoWeekOf(new Date(Date.UTC(2027, 0, 4)))).toBe('2027-W01');
  });
});

describe('allowance run store', () => {
  test('round-trips the run record and clears it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowance-store-'));
    process.env.ZAPLIE_DATA_DIR = dir;

    expect(readLastRun()).toBeNull();

    const record: AllowanceRunRecord = {
      isoWeek: '2026-W34',
      startedAt: '2026-08-18T05:59:00.000Z',
      lastSuccessAt: '2026-08-18T06:00:00.000Z',
      summary: { wallets: 2, swept: 1, toppedUp: 2, failed: 0, warned: 0 },
    };
    recordRun(record);
    expect(readLastRun()).toEqual(record);

    clearRun();
    expect(readLastRun()).toBeNull();
    // Clearing an already-absent guard is not an error.
    expect(() => clearRun()).not.toThrow();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('fails closed on a corrupt or unrecognised guard file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowance-store-'));
    process.env.ZAPLIE_DATA_DIR = dir;
    const file = path.join(dir, 'allowance-runs.json');

    // A guard we cannot read must never be mistaken for "never ran": that
    // would authorise a second sweep of the same week.
    fs.writeFileSync(file, 'not json');
    expect(() => readLastRun()).toThrow(AllowanceGuardError);

    fs.writeFileSync(file, JSON.stringify({ isoWeek: '2026-W34' }));
    expect(() => readLastRun()).toThrow(AllowanceGuardError);

    fs.writeFileSync(
      file,
      JSON.stringify({ isoWeek: '2026-W34', startedAt: 'not-a-date' }),
    );
    expect(() => readLastRun()).toThrow(AllowanceGuardError);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('createAllowanceTopupHandler', () => {
  test('rejects a missing or wrong API key with 401', async () => {
    const runTopup = jest.fn();
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => false,
      runTopup,
    });
    const res = response();

    await handler(request(), res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'invalid API key' });
    expect(runTopup).not.toHaveBeenCalled();
  });

  test('surfaces a RewardError from key validation with its status', async () => {
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => {
        throw new RewardError('rewards endpoint disabled', 503);
      },
    });
    const res = response();

    await handler(request('any'), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'rewards endpoint disabled' });
  });

  test('returns 503 when the LNbits configuration is incomplete', async () => {
    delete process.env.LNBITS_INKEY;
    const runTopup = jest.fn();
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => true,
      runTopup,
    });
    const res = response();

    await handler(request('valid-key'), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: expect.stringContaining('allowance topup not configured'),
    });
    expect(runTopup).not.toHaveBeenCalled();
  });

  test('refuses to sweep when the run guard cannot be read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const runTopup = jest.fn();
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => true,
      runTopup,
      assertConfig: passingConfig,
      getLastRun: () => {
        throw new AllowanceGuardError('allowance run guard is invalid');
      },
    });
    const res = response();

    await handler(request('valid-key'), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'allowance guard unavailable' });
    expect(runTopup).not.toHaveBeenCalled();
  });

  test('runs the topup and records the week on success', async () => {
    const saveRun = jest.fn();
    const now = new Date('2026-08-18T06:00:00.000Z');
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => true,
      runTopup: async () => summary(),
      assertConfig: passingConfig,
      getLastRun: () => null,
      saveRun,
      now: () => now,
    });
    const res = response();

    await handler(request('valid-key'), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      skipped: false,
      wallets: 2,
      swept: 1,
      toppedUp: 2,
      failed: 0,
      failures: [],
      lastSuccessAt: '2026-08-18T06:00:00.000Z',
    });
    // The week is claimed before the sweep begins, then completed.
    expect(saveRun).toHaveBeenNthCalledWith(1, {
      isoWeek: '2026-W34',
      startedAt: '2026-08-18T06:00:00.000Z',
    });
    expect(saveRun).toHaveBeenNthCalledWith(2, {
      isoWeek: '2026-W34',
      startedAt: '2026-08-18T06:00:00.000Z',
      lastSuccessAt: '2026-08-18T06:00:00.000Z',
      summary: { wallets: 2, swept: 1, toppedUp: 2, failed: 0, warned: 0 },
    });
  });

  test('reports per-wallet failures and warnings and keeps the week guard', async () => {
    const saveRun = jest.fn();
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => true,
      runTopup: async () =>
        summary({
          swept: 1,
          toppedUp: 1,
          failures: [{ walletId: 'wallet-2', error: 'payment failed' }],
          warnings: [{ walletId: 'wallet-1', warning: 'left 500 msat' }],
        }),
      assertConfig: passingConfig,
      getLastRun: () => null,
      saveRun,
      now: () => new Date('2026-08-18T06:00:00.000Z'),
    });
    const res = response();

    await handler(request('valid-key'), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      skipped: false,
      failed: 1,
      failures: [{ walletId: 'wallet-2', error: 'payment failed' }],
      warnings: [{ walletId: 'wallet-1', warning: 'left 500 msat' }],
      lastError: 'payment failed',
    });
    expect(saveRun).toHaveBeenCalledTimes(2);
    expect(saveRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        summary: { wallets: 2, swept: 1, toppedUp: 1, failed: 1, warned: 1 },
      }),
    );
  });

  test('drops the week guard when the run proved no funds moved', async () => {
    const saveRun = jest.fn();
    const clearLastRun = jest.fn();
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => true,
      runTopup: async () =>
        summary({
          swept: 0,
          toppedUp: 0,
          failures: [
            { walletId: 'wallet-1', error: 'LNbits unavailable' },
            { walletId: 'wallet-2', error: 'LNbits unavailable' },
          ],
        }),
      assertConfig: passingConfig,
      getLastRun: () => null,
      saveRun,
      clearLastRun,
    });
    const res = response();

    await handler(request('valid-key'), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ skipped: false, failed: 2 });
    // Only the pre-run claim was written, and it is withdrawn again so the
    // scheduler's retry can try the week once more.
    expect(saveRun).toHaveBeenCalledTimes(1);
    expect(clearLastRun).toHaveBeenCalledTimes(1);
  });

  test('skips a duplicate trigger inside the same ISO week', async () => {
    const runTopup = jest.fn();
    const lastRun: AllowanceRunRecord = {
      isoWeek: '2026-W34',
      startedAt: '2026-08-17T05:59:00.000Z',
      lastSuccessAt: '2026-08-17T06:00:00.000Z',
      summary: { wallets: 2, swept: 2, toppedUp: 2, failed: 0, warned: 0 },
    };
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => true,
      runTopup,
      assertConfig: passingConfig,
      getLastRun: () => lastRun,
      now: () => new Date('2026-08-18T06:00:00.000Z'),
    });
    const res = response();

    await handler(request('valid-key'), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ skipped: true, lastRun });
    expect(runTopup).not.toHaveBeenCalled();
  });

  test('skips a week whose run started and never reported back', async () => {
    const runTopup = jest.fn();
    const lastRun: AllowanceRunRecord = {
      isoWeek: '2026-W34',
      startedAt: '2026-08-18T05:59:00.000Z',
      lastErrorAt: '2026-08-18T05:59:30.000Z',
      lastError: 'LNbits unreachable',
    };
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => true,
      runTopup,
      assertConfig: passingConfig,
      getLastRun: () => lastRun,
      now: () => new Date('2026-08-18T06:00:00.000Z'),
    });
    const res = response();

    await handler(request('valid-key'), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ skipped: true, lastRun });
    expect(runTopup).not.toHaveBeenCalled();
  });

  test('two concurrent triggers share a single sweep', async () => {
    let release: () => void = () => undefined;
    const started = new Promise<void>(resolve => {
      release = resolve;
    });
    const runTopup = jest.fn(async () => {
      await started;
      return summary();
    });
    const saveRun = jest.fn();
    // Both requests observe an empty guard: the persisted record cannot help
    // here because neither has written anything yet.
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => true,
      runTopup,
      assertConfig: passingConfig,
      getLastRun: () => null,
      saveRun,
      now: () => new Date('2026-08-18T06:00:00.000Z'),
    });
    const first = response();
    const second = response();

    const requests = Promise.all([
      handler(request('valid-key'), first),
      handler(request('valid-key'), second),
    ]);
    release();
    await requests;

    expect(runTopup).toHaveBeenCalledTimes(1);
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ skipped: false, swept: 1 });
    expect(second.statusCode).toBe(200);
    expect(second.body).toMatchObject({
      skipped: true,
      lastRun: expect.objectContaining({ isoWeek: '2026-W34' }),
    });
  });

  test('runs again in a new ISO week', async () => {
    const saveRun = jest.fn();
    const runTopup = jest.fn(async () => summary());
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => true,
      runTopup,
      assertConfig: passingConfig,
      getLastRun: () => ({
        isoWeek: '2026-W33',
        startedAt: '2026-08-11T05:59:00.000Z',
        lastSuccessAt: '2026-08-11T06:00:00.000Z',
        summary: { wallets: 2, swept: 2, toppedUp: 2, failed: 0, warned: 0 },
      }),
      saveRun,
      now: () => new Date('2026-08-18T06:00:00.000Z'),
    });
    const res = response();

    await handler(request('valid-key'), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ skipped: false });
    expect(runTopup).toHaveBeenCalledTimes(1);
  });

  test('answers 500 without internals and keeps the week when the run throws', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const saveRun = jest.fn();
    const clearLastRun = jest.fn();
    const handler = createAllowanceTopupHandler({
      isAuthorized: async () => true,
      runTopup: async () => {
        throw new Error('Unable to load allowance wallets');
      },
      assertConfig: passingConfig,
      getLastRun: () => null,
      saveRun,
      clearLastRun,
      now: () => new Date('2026-08-18T06:00:00.000Z'),
    });
    const res = response();

    await handler(request('valid-key'), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
    // The run's effect is unknown, so the week stays claimed for an operator.
    expect(clearLastRun).not.toHaveBeenCalled();
    expect(saveRun).toHaveBeenLastCalledWith({
      isoWeek: '2026-W34',
      startedAt: '2026-08-18T06:00:00.000Z',
      lastErrorAt: '2026-08-18T06:00:00.000Z',
      lastError: 'Unable to load allowance wallets',
    });
  });
});
