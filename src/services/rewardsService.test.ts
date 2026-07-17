import {
  parseRewardRequest,
  resolveAmountSats,
  payReward,
  RewardError,
} from './rewardsService';
import {
  getUserWallets,
  createInvoice,
  payInvoice,
} from './lnbitsService';
import { getRewardAmounts } from './fetchRewardAmounts';
import { expect, describe, test, beforeEach, jest } from '@jest/globals';

jest.mock('./lnbitsService');
jest.mock('./fetchRewardAmounts');

const mockedGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;
const mockedCreateInvoice = createInvoice as jest.MockedFunction<
  typeof createInvoice
>;
const mockedPayInvoice = payInvoice as jest.MockedFunction<typeof payInvoice>;
const mockedGetRewardAmounts = getRewardAmounts as jest.MockedFunction<
  typeof getRewardAmounts
>;

const privateWallet: Wallet = {
  id: 'wallet-1',
  admin: 'admin-1',
  name: 'Private',
  user: 'lnbits-user-1',
  adminkey: 'wallet-adminkey',
  inkey: 'wallet-inkey',
  balance_msat: 0,
  deleted: false,
};

const validReward = {
  recipient: 'octocat',
  amountSats: 210,
  reason: 'GitHub: PR #7 merged',
  source: 'github',
};

describe('parseRewardRequest', () => {
  test('returns the parsed reward for a valid payload', () => {
    expect(parseRewardRequest(validReward)).toEqual(validReward);
  });

  test.each([
    ['missing recipient', { ...validReward, recipient: undefined }],
    ['empty recipient', { ...validReward, recipient: '' }],
    ['missing amountSats', { ...validReward, amountSats: undefined }],
    ['zero amountSats', { ...validReward, amountSats: 0 }],
    ['negative amountSats', { ...validReward, amountSats: -5 }],
    ['fractional amountSats', { ...validReward, amountSats: 1.5 }],
    ['string amountSats', { ...validReward, amountSats: '100' }],
    ['missing reason', { ...validReward, reason: undefined }],
    ['missing source', { ...validReward, source: undefined }],
    ['null body', null],
    ['amountSats above the default cap', { ...validReward, amountSats: 10001 }],
  ])('rejects %s with a 400', (_label, body) => {
    expect(() => parseRewardRequest(body)).toThrow(RewardError);
    try {
      parseRewardRequest(body);
    } catch (error) {
      expect((error as RewardError).statusCode).toBe(400);
    }
  });
});

describe('parseRewardRequest cap', () => {
  test('accepts amounts up to the default cap and honours REWARDS_MAX_AMOUNT_SATS', () => {
    expect(parseRewardRequest({ ...validReward, amountSats: 10000 }).amountSats).toBe(10000);

    process.env.REWARDS_MAX_AMOUNT_SATS = '500';
    expect(() => parseRewardRequest({ ...validReward, amountSats: 501 })).toThrow(
      'per-reward cap of 500',
    );
    delete process.env.REWARDS_MAX_AMOUNT_SATS;
  });
});

describe('parseRewardRequest eventType', () => {
  test('accepts a payload with eventType and no amountSats', () => {
    const { amountSats: _omit, ...withoutAmount } = validReward;
    const parsed = parseRewardRequest({
      ...withoutAmount,
      eventType: 'githubPrMerged',
    });
    expect(parsed.amountSats).toBeUndefined();
    expect(parsed.eventType).toBe('githubPrMerged');
  });

  test('rejects a payload missing both amountSats and eventType', () => {
    const { amountSats: _omit, ...withoutAmount } = validReward;
    expect(() => parseRewardRequest(withoutAmount)).toThrow(
      'either amountSats or eventType is required',
    );
  });
});

describe('resolveAmountSats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns amountSats unchanged and never consults the config', async () => {
    const request = parseRewardRequest(validReward);
    await expect(resolveAmountSats(request)).resolves.toBe(210);
    expect(mockedGetRewardAmounts).not.toHaveBeenCalled();
  });

  test('resolves eventType against the configured reward amounts', async () => {
    mockedGetRewardAmounts.mockResolvedValue({ githubPrMergedSats: 777 });
    const { amountSats: _omit, ...withoutAmount } = validReward;
    const request = parseRewardRequest({
      ...withoutAmount,
      eventType: 'githubPrMerged',
    });

    await expect(resolveAmountSats(request)).resolves.toBe(777);
  });

  test('rejects an unknown eventType with a 400 and the exact message', async () => {
    mockedGetRewardAmounts.mockResolvedValue({ githubPrMergedSats: 777 });
    const { amountSats: _omit, ...withoutAmount } = validReward;
    const request = parseRewardRequest({
      ...withoutAmount,
      eventType: 'coffeeBreak',
    });

    await expect(resolveAmountSats(request)).rejects.toThrow(
      "no configured amount for eventType 'coffeeBreak'",
    );
    await expect(resolveAmountSats(request)).rejects.toHaveProperty(
      'statusCode',
      400,
    );
  });

  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'rejects a prototype-pollution eventType "%s" with a 400 and never resolves',
    async eventTypeValue => {
      mockedGetRewardAmounts.mockResolvedValue({ githubPrMergedSats: 777 });
      const { amountSats: _omit, ...withoutAmount } = validReward;
      const request = parseRewardRequest({
        ...withoutAmount,
        eventType: eventTypeValue,
      });

      await expect(resolveAmountSats(request)).rejects.toHaveProperty(
        'statusCode',
        400,
      );
    },
  );

  test.each([
    ['NaN', NaN],
    ['negative', -50],
    ['zero', 0],
    ['fractional', 12.5],
    ['above the cap', 20000],
  ])(
    'throws a plain Error when the configured amount is %s',
    async (_label, configuredAmount) => {
      mockedGetRewardAmounts.mockResolvedValue({
        githubPrMergedSats: configuredAmount,
      });
      const { amountSats: _omit, ...withoutAmount } = validReward;
      const request = parseRewardRequest({
        ...withoutAmount,
        eventType: 'githubPrMerged',
      });

      await expect(resolveAmountSats(request)).rejects.not.toBeInstanceOf(
        RewardError,
      );
      await expect(resolveAmountSats(request)).rejects.toThrow(
        'configured amount',
      );
    },
  );

  test('propagates a config fetch rejection', async () => {
    mockedGetRewardAmounts.mockRejectedValue(new Error('backend unreachable'));
    const { amountSats: _omit, ...withoutAmount } = validReward;
    const request = parseRewardRequest({
      ...withoutAmount,
      eventType: 'githubPrMerged',
    });

    await expect(resolveAmountSats(request)).rejects.toThrow(
      'backend unreachable',
    );
  });
});

describe('payReward', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REWARDS_TREASURY_ADMINKEY = 'treasury-adminkey';
    process.env.LNBITS_ADMINKEY = 'lnbits-adminkey';
    process.env.REWARDS_GITHUB_USER_MAP = JSON.stringify({
      octocat: 'lnbits-user-1',
    });
  });

  test('pays the recipient private wallet from the treasury wallet', async () => {
    mockedGetUserWallets.mockResolvedValue([privateWallet]);
    mockedCreateInvoice.mockResolvedValue('lnbc-payment-request');
    mockedPayInvoice.mockResolvedValue({ payment_hash: 'hash-1' });

    const result = await payReward(validReward);

    expect(result).toEqual({ paymentHash: 'hash-1' });
    expect(mockedGetUserWallets).toHaveBeenCalledWith(
      'lnbits-adminkey',
      'lnbits-user-1',
    );
    expect(mockedCreateInvoice).toHaveBeenCalledWith(
      'wallet-inkey',
      'wallet-1',
      210,
      'GitHub: PR #7 merged',
      expect.objectContaining({ tag: 'zap', source: 'github' }),
    );
    expect(mockedPayInvoice).toHaveBeenCalledWith(
      'treasury-adminkey',
      'lnbc-payment-request',
      expect.anything(),
    );
  });

  test('does not embed wallet keys in the payment extra', async () => {
    mockedGetUserWallets.mockResolvedValue([privateWallet]);
    mockedCreateInvoice.mockResolvedValue('lnbc-payment-request');
    mockedPayInvoice.mockResolvedValue({ payment_hash: 'hash-1' });

    await payReward(validReward);

    const extra = mockedCreateInvoice.mock.calls[0][4];
    expect(JSON.stringify(extra)).not.toContain('adminkey');
    expect(JSON.stringify(extra)).not.toContain('inkey');
  });

  test('rejects Object.prototype key names as recipients with a 404', async () => {
    for (const recipient of ['constructor', 'toString', 'hasOwnProperty']) {
      await expect(payReward({ ...validReward, recipient })).rejects.toHaveProperty(
        'statusCode',
        404,
      );
    }
    expect(mockedGetUserWallets).not.toHaveBeenCalled();
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('rejects an unmapped recipient with a 404 and pays nothing', async () => {
    await expect(
      payReward({ ...validReward, recipient: 'stranger' }),
    ).rejects.toThrow('no LNbits user mapped');
    await expect(
      payReward({ ...validReward, recipient: 'stranger' }),
    ).rejects.toHaveProperty('statusCode', 404);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('throws when the recipient has no Private wallet', async () => {
    mockedGetUserWallets.mockResolvedValue([
      { ...privateWallet, name: 'Allowance' },
    ]);

    await expect(payReward(validReward)).rejects.toThrow(
      'has no Private wallet',
    );
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('throws when createInvoice returns an error instead of a bolt11', async () => {
    mockedGetUserWallets.mockResolvedValue([privateWallet]);
    mockedCreateInvoice.mockResolvedValue(new Error('lnbits down'));

    await expect(payReward(validReward)).rejects.toThrow(
      'creating reward invoice failed',
    );
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('throws when payInvoice returns no payment hash', async () => {
    mockedGetUserWallets.mockResolvedValue([privateWallet]);
    mockedCreateInvoice.mockResolvedValue('lnbc-payment-request');
    mockedPayInvoice.mockResolvedValue({ detail: 'insufficient balance' });

    await expect(payReward(validReward)).rejects.toThrow(
      'paying reward invoice failed',
    );
  });

  test('throws when REWARDS_GITHUB_USER_MAP is not set', async () => {
    delete process.env.REWARDS_GITHUB_USER_MAP;

    await expect(payReward(validReward)).rejects.toThrow(
      'REWARDS_GITHUB_USER_MAP is not set',
    );
  });
});
