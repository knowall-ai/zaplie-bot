import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Context, HttpRequest } from '@azure/functions';
import automateZap, { validateZapRequestBody, getMaxZapAmount } from './index';

const makeContext = (): { context: Context; getRes: () => { status: number; body: unknown } } => {
  let response: { status: number; body: unknown } | undefined;
  const context = {
    log: Object.assign((..._args: unknown[]) => {}, {
      error: (..._args: unknown[]) => {},
      warn: (..._args: unknown[]) => {},
      info: (..._args: unknown[]) => {},
      verbose: (..._args: unknown[]) => {},
    }),
    get res() {
      return response;
    },
    set res(val) {
      response = val as { status: number; body: unknown };
    },
  } as unknown as Context;

  return { context, getRes: () => response! };
};

const makeRequest = (body: unknown): HttpRequest =>
  ({
    body,
    headers: {},
    query: { siteURL: 'https://lnbits.example.com', adminkey: 'adminkey123' },
  }) as unknown as HttpRequest;

const validBody = {
  senderWalletId: 'sender-wallet-1',
  receiverWalletId: 'receiver-wallet-2',
  zapAmount: 21,
  zapMessage: 'Thanks for your help!',
  tag: 'zap',
};

describe('functions/sendZap', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ZAP_MAX_AMOUNT_SATS;
    delete process.env.REWARDS_MAX_AMOUNT_SATS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getMaxZapAmount', () => {
    test('defaults to 1,000,000 when env vars are unset', () => {
      assert.equal(getMaxZapAmount(), 1_000_000);
    });

    test('prefers ZAP_MAX_AMOUNT_SATS when set', () => {
      process.env.ZAP_MAX_AMOUNT_SATS = '5000';
      process.env.REWARDS_MAX_AMOUNT_SATS = '10000';
      assert.equal(getMaxZapAmount(), 5000);
    });

    test('falls back to REWARDS_MAX_AMOUNT_SATS when ZAP_MAX_AMOUNT_SATS is unset', () => {
      process.env.REWARDS_MAX_AMOUNT_SATS = '15000';
      assert.equal(getMaxZapAmount(), 15000);
    });

    test('falls back to default when env vars are invalid', () => {
      process.env.ZAP_MAX_AMOUNT_SATS = 'not-a-number';
      assert.equal(getMaxZapAmount(), 1_000_000);
    });
  });

  describe('validateZapRequestBody', () => {
    test('accepts valid request body with all fields', () => {
      const result = validateZapRequestBody(validBody);
      assert.equal(result.valid, true);
      assert.deepEqual(result.value, validBody);
    });

    test('accepts valid request body without optional tag', () => {
      const { tag, ...withoutTag } = validBody;
      const result = validateZapRequestBody(withoutTag);
      assert.equal(result.valid, true);
      assert.equal(result.value?.senderWalletId, 'sender-wallet-1');
      assert.equal(result.value?.tag, undefined);
    });

    test('rejects non-object body', () => {
      assert.equal(validateZapRequestBody(null).valid, false);
      assert.equal(validateZapRequestBody(undefined).valid, false);
      assert.equal(validateZapRequestBody('string').valid, false);
      assert.equal(validateZapRequestBody(123).valid, false);
      assert.equal(validateZapRequestBody([validBody]).valid, false);
    });

    test('rejects unknown fields in request body', () => {
      const result = validateZapRequestBody({ ...validBody, extraField: 'unexpected' });
      assert.equal(result.valid, false);
      assert.match(result.error!, /Unknown field\(s\) in request body: extraField/);
    });

    test('rejects missing or empty senderWalletId', () => {
      const missing = validateZapRequestBody({ ...validBody, senderWalletId: undefined });
      assert.equal(missing.valid, false);
      assert.match(missing.error!, /senderWalletId must be a non-empty string/);

      const empty = validateZapRequestBody({ ...validBody, senderWalletId: '   ' });
      assert.equal(empty.valid, false);
      assert.match(empty.error!, /senderWalletId must be a non-empty string/);
    });

    test('rejects missing or empty receiverWalletId', () => {
      const missing = validateZapRequestBody({ ...validBody, receiverWalletId: undefined });
      assert.equal(missing.valid, false);
      assert.match(missing.error!, /receiverWalletId must be a non-empty string/);

      const empty = validateZapRequestBody({ ...validBody, receiverWalletId: '' });
      assert.equal(empty.valid, false);
      assert.match(empty.error!, /receiverWalletId must be a non-empty string/);
    });

    test('rejects non-string zapMessage', () => {
      const result = validateZapRequestBody({ ...validBody, zapMessage: 123 });
      assert.equal(result.valid, false);
      assert.match(result.error!, /zapMessage must be a string/);
    });

    test('rejects non-string tag when provided', () => {
      const result = validateZapRequestBody({ ...validBody, tag: 456 });
      assert.equal(result.valid, false);
      assert.match(result.error!, /tag must be a string/);
    });

    test('rejects non-integer zapAmount', () => {
      const floatVal = validateZapRequestBody({ ...validBody, zapAmount: 10.5 });
      assert.equal(floatVal.valid, false);
      assert.match(floatVal.error!, /zapAmount must be a positive integer/);

      const stringVal = validateZapRequestBody({ ...validBody, zapAmount: '21' });
      assert.equal(stringVal.valid, false);
      assert.match(stringVal.error!, /zapAmount must be a positive integer/);

      const nanVal = validateZapRequestBody({ ...validBody, zapAmount: NaN });
      assert.equal(nanVal.valid, false);
      assert.match(nanVal.error!, /zapAmount must be a positive integer/);
    });

    test('rejects zero or negative zapAmount', () => {
      const zeroVal = validateZapRequestBody({ ...validBody, zapAmount: 0 });
      assert.equal(zeroVal.valid, false);
      assert.match(zeroVal.error!, /zapAmount must be a positive integer/);

      const negVal = validateZapRequestBody({ ...validBody, zapAmount: -50 });
      assert.equal(negVal.valid, false);
      assert.match(negVal.error!, /zapAmount must be a positive integer/);
    });

    test('rejects zapAmount exceeding cap', () => {
      process.env.ZAP_MAX_AMOUNT_SATS = '500';
      const result = validateZapRequestBody({ ...validBody, zapAmount: 501 });
      assert.equal(result.valid, false);
      assert.match(result.error!, /zapAmount exceeds the configured maximum cap of 500/);
    });
  });

  describe('automateZap handler HTTP 400 responses', () => {
    test('returns 400 on invalid body without calling getUser', async () => {
      const { context, getRes } = makeContext();
      const req = makeRequest(null);

      await automateZap(context, req);
      const res = getRes();
      assert.equal(res.status, 400);
      assert.match(String(res.body), /Invalid request body: Request body must be a valid JSON object/);
    });

    test('returns 400 on unknown keys in body', async () => {
      const { context, getRes } = makeContext();
      const req = makeRequest({ ...validBody, invalidKey: 123 });

      await automateZap(context, req);
      const res = getRes();
      assert.equal(res.status, 400);
      assert.match(String(res.body), /Invalid request body: Unknown field\(s\) in request body: invalidKey/);
    });

    test('returns 400 on negative zapAmount', async () => {
      const { context, getRes } = makeContext();
      const req = makeRequest({ ...validBody, zapAmount: -10 });

      await automateZap(context, req);
      const res = getRes();
      assert.equal(res.status, 400);
      assert.match(String(res.body), /Invalid request body: zapAmount must be a positive integer/);
    });

    test('returns 400 on zapAmount exceeding configured cap', async () => {
      process.env.ZAP_MAX_AMOUNT_SATS = '1000';
      const { context, getRes } = makeContext();
      const req = makeRequest({ ...validBody, zapAmount: 1001 });

      await automateZap(context, req);
      const res = getRes();
      assert.equal(res.status, 400);
      assert.match(String(res.body), /Invalid request body: zapAmount exceeds the configured maximum cap of 1000/);
    });
  });
});
