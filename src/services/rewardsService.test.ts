import {
  parseRewardRequest,
  payReward,
  resolveAmountSats,
  resolveRewardRecipient,
  selectLevel,
  RewardError,
  RewardPaymentUncertainError,
} from './rewardsService';
import { getRewardConfig, RewardPolicy } from './fetchRewardPolicy';
import { payInvoice } from './lnbitsService';
import { createInvoiceForPerson } from './peopleDirectory';
import { resolveRewardRecipientByGithubId } from './identityService';
import {
  createPendingReward,
  PendingRewardWriteUncertainError,
} from './pendingRewardsService';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';

jest.mock('./fetchRewardPolicy', () => ({ getRewardConfig: jest.fn() }));
jest.mock('./peopleDirectory', () => ({
  createInvoiceForPerson: jest.fn(),
}));
jest.mock('./lnbitsService', () => ({
  payInvoice: jest.fn(),
}));
jest.mock('./identityService', () => ({
  resolveRewardRecipientByGithubId: jest.fn(),
}));
jest.mock('./pendingRewardsService', () => ({
  ...jest.requireActual<object>('./pendingRewardsService'),
  createPendingReward: jest.fn(),
}));

const mockedCreatePendingReward = createPendingReward as unknown as AsyncMock;
const mockedGetRewardConfig = getRewardConfig as jest.MockedFunction<
  typeof getRewardConfig
>;
const emptyPolicy = (): RewardPolicy => ({
  version: 1,
  levels: {},
  overrides: {},
  budget: null,
});
// Amounts as stored by the portal; the policy defaults to empty (no bonus,
// no override), which is what an unconfigured portal returns.
const mockConfig = (
  rewardAmounts: Record<string, number>,
  policy: Partial<RewardPolicy> = {},
) =>
  mockedGetRewardConfig.mockResolvedValue({
    rewardAmounts,
    rewardPolicy: { ...emptyPolicy(), ...policy },
  });
type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const mockedPayInvoice = payInvoice as unknown as AsyncMock;
const mockedCreateInvoice = createInvoiceForPerson as unknown as AsyncMock;
const mockedResolveRecipient =
  resolveRewardRecipientByGithubId as unknown as AsyncMock;

const validReward = {
  recipient: 'octocat',
  recipientId: '583231',
  eventType: 'githubPrMerged',
  repo: 'octo-org/octo-repo',
  reason: 'GitHub: PR #7 merged',
  source: 'github' as const,
};

describe('parseRewardRequest', () => {
  test('returns the normalized GitHub reward payload', () => {
    expect(parseRewardRequest(validReward)).toEqual({
      ...validReward,
      labels: [],
    });
    expect(parseRewardRequest({ ...validReward, recipientId: 583231 })).toEqual(
      { ...validReward, labels: [] },
    );
    expect(
      parseRewardRequest({ ...validReward, labels: ['reward:L2', 'bug'] }),
    ).toMatchObject({ labels: ['reward:L2', 'bug'] });
  });

  test.each([
    ['missing recipient', { ...validReward, recipient: undefined }],
    ['empty recipient', { ...validReward, recipient: '' }],
    ['whitespace recipient', { ...validReward, recipient: '  ' }],
    ['non-string recipient', { ...validReward, recipient: 42 }],
    ['missing recipientId', { ...validReward, recipientId: undefined }],
    ['empty recipientId', { ...validReward, recipientId: '' }],
    ['whitespace recipientId', { ...validReward, recipientId: '  ' }],
    ['non-numeric recipientId', { ...validReward, recipientId: 'octocat' }],
    ['zero recipientId', { ...validReward, recipientId: 0 }],
    ['negative recipientId', { ...validReward, recipientId: -1 }],
    ['fractional recipientId', { ...validReward, recipientId: 1.5 }],
    ['missing eventType', { ...validReward, eventType: undefined }],
    ['empty eventType', { ...validReward, eventType: '' }],
    ['non-GitHub eventType', { ...validReward, eventType: 'timesheetWeek' }],
    [
      'unknown GitHub eventType',
      { ...validReward, eventType: 'githubCoffeeBreak' },
    ],
    ['missing repo', { ...validReward, repo: undefined }],
    ['empty repo', { ...validReward, repo: '' }],
    ['malformed repo', { ...validReward, repo: 'octo-repo' }],
    ['missing reason', { ...validReward, reason: undefined }],
    ['empty reason', { ...validReward, reason: '  ' }],
    ['non-string reason', { ...validReward, reason: 42 }],
    ['missing source', { ...validReward, source: undefined }],
    ['non-GitHub source', { ...validReward, source: 'timesheet' }],
    ['caller-supplied amount', { ...validReward, amountSats: 21 }],
    ['labels that are not an array', { ...validReward, labels: 'reward:L1' }],
    ['a non-string label', { ...validReward, labels: [7] }],
    ['an empty label', { ...validReward, labels: [''] }],
    ['a non-ASCII label', { ...validReward, labels: ['récompense'] }],
    [
      'a label over 50 characters',
      { ...validReward, labels: ['x'.repeat(51)] },
    ],
    [
      'more than 50 labels',
      { ...validReward, labels: Array.from({ length: 51 }, (_, i) => `l${i}`) },
    ],
    ['null body', null],
  ])('rejects %s with a 400', (_label, body) => {
    expect(() => parseRewardRequest(body)).toThrow(RewardError);
    try {
      parseRewardRequest(body);
    } catch (error) {
      expect((error as RewardError).statusCode).toBe(400);
    }
  });
});

describe('resolveAmountSats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('resolves eventType against the configured reward amounts', async () => {
    mockConfig({ githubPrMergedSats: 777 });

    await expect(
      resolveAmountSats(parseRewardRequest(validReward), null),
    ).resolves.toEqual({
      amountSats: 777,
      baseSats: 777,
      bonusSats: 0,
      level: null,
    });
  });

  test('an event with no configured amount is a 503, not a default', async () => {
    mockConfig({ githubIssueClosedSats: 500 });

    await expect(
      resolveAmountSats(parseRewardRequest(validReward), null),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  test('rejects a retired event even when stale config still contains it', () => {
    mockConfig({ timesheetWeekSats: 800 });

    expect(() =>
      parseRewardRequest({ ...validReward, eventType: 'timesheetWeek' }),
    ).toThrow(RewardError);
    expect(mockedGetRewardConfig).not.toHaveBeenCalled();
  });

  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'rejects a prototype-pollution eventType "%s" before reading config',
    eventType => {
      expect(() => parseRewardRequest({ ...validReward, eventType })).toThrow(
        RewardError,
      );
      expect(mockedGetRewardConfig).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['NaN', Number.NaN],
    ['negative', -50],
    ['zero', 0],
    ['fractional', 12.5],
    ['above the cap', 20000],
  ])(
    'fails closed when the configured amount is %s',
    async (_label, configuredAmount) => {
      mockConfig({
        githubPrMergedSats: configuredAmount,
      });

      await expect(
        resolveAmountSats(parseRewardRequest(validReward), null),
      ).rejects.toThrow('configured amount');
    },
  );

  test('propagates a config fetch rejection', async () => {
    mockedGetRewardConfig.mockRejectedValue(new Error('backend unreachable'));

    await expect(
      resolveAmountSats(parseRewardRequest(validReward), null),
    ).rejects.toThrow('backend unreachable');
  });
});

const RECIPIENT = {
  personAad: '11111111-2222-3333-4444-555555555555',
};

describe('payReward', () => {
  const savedTreasuryKey = process.env.REWARDS_TREASURY_ADMINKEY;
  const reward = {
    recipient: 'octocat',
    recipientId: '583231',
    amountSats: 21,
    eventType: 'githubPrMerged',
    repo: 'octo-org/octo-repo',
    reason: 'GitHub: PR #7 merged',
    source: 'github',
  };

  beforeEach(() => {
    process.env.REWARDS_TREASURY_ADMINKEY = 'treasury-admin-key';
    mockedResolveRecipient.mockResolvedValue({ personAad: 'oid-1' });
    mockedCreateInvoice.mockResolvedValue('lnbc-invoice');
    mockedPayInvoice.mockResolvedValue({ payment_hash: 'hash-1' });
  });

  afterEach(() => {
    if (savedTreasuryKey === undefined) {
      delete process.env.REWARDS_TREASURY_ADMINKEY;
    } else {
      process.env.REWARDS_TREASURY_ADMINKEY = savedTreasuryKey;
    }
  });

  test('returns the payment hash of a settled payment', async () => {
    await expect(payReward(reward, RECIPIENT)).resolves.toEqual({
      paymentHash: 'hash-1',
    });
  });

  test('a payInvoice that throws is an uncertain outcome', async () => {
    mockedPayInvoice.mockRejectedValue(new Error('socket hang up'));

    await expect(payReward(reward, RECIPIENT)).rejects.toBeInstanceOf(
      RewardPaymentUncertainError,
    );
  });

  test('a payInvoice with no payment hash is an uncertain outcome', async () => {
    mockedPayInvoice.mockResolvedValue({ detail: 'something odd' });

    await expect(payReward(reward, RECIPIENT)).rejects.toBeInstanceOf(
      RewardPaymentUncertainError,
    );
  });

  test('a failure before payInvoice is a plain error', async () => {
    mockedCreateInvoice.mockRejectedValue(new Error('LNbits down'));

    const error = await payReward(reward, RECIPIENT).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RewardPaymentUncertainError);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a pending write with an unknown outcome is an uncertain outcome', async () => {
    mockedCreatePendingReward.mockRejectedValue(
      new PendingRewardWriteUncertainError('socket hang up'),
    );

    await expect(payReward(reward, null)).rejects.toBeInstanceOf(
      RewardPaymentUncertainError,
    );
  });

  test('a pending write the portal rejected stays a plain error', async () => {
    mockedCreatePendingReward.mockRejectedValue(
      new Error('pending reward write failed: 400'),
    );

    const error = await payReward(reward, null).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RewardPaymentUncertainError);
  });

  test('a recipient with no receive target fails before payInvoice', async () => {
    mockedCreateInvoice.mockRejectedValue(
      new Error('octocat has not set up where they receive zaps yet'),
    );

    const error = await payReward(reward, RECIPIENT).catch(
      (caught: unknown) => caught,
    );

    expect(error).not.toBeInstanceOf(RewardPaymentUncertainError);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });
});

describe('reward policy: base override and level bonus', () => {
  const OID = RECIPIENT.personAad;
  const levels = {
    githubPrMerged: {
      labelPrefix: 'reward:',
      bonuses: { L1: 250, L2: 500, L3: 1000 },
    },
  };
  const withLabels = (labels: string[]) =>
    parseRewardRequest({ ...validReward, labels });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a per-person override beats the org base', async () => {
    mockConfig(
      { githubPrMergedSats: 1000 },
      { overrides: { [OID]: { githubPrMerged: { baseSats: 1500 } } } },
    );

    await expect(resolveAmountSats(withLabels([]), RECIPIENT)).resolves.toEqual(
      {
        amountSats: 1500,
        baseSats: 1500,
        bonusSats: 0,
        level: null,
      },
    );
  });

  test('an override matches an upper-case oid from the identity graph', async () => {
    mockConfig(
      { githubPrMergedSats: 1000 },
      { overrides: { [OID]: { githubPrMerged: { baseSats: 1500 } } } },
    );

    await expect(
      resolveAmountSats(withLabels([]), {
        ...RECIPIENT,
        personAad: OID.toUpperCase(),
      }),
    ).resolves.toMatchObject({ baseSats: 1500 });
  });

  test('an override for another event leaves this one on the org base', async () => {
    mockConfig(
      { githubPrMergedSats: 1000 },
      { overrides: { [OID]: { githubIssueClosed: { baseSats: 9 } } } },
    );

    await expect(
      resolveAmountSats(withLabels([]), RECIPIENT),
    ).resolves.toMatchObject({ baseSats: 1000 });
  });

  test('an override pays even when no org base is configured', async () => {
    mockConfig(
      {},
      { overrides: { [OID]: { githubPrMerged: { baseSats: 1500 } } } },
    );

    await expect(
      resolveAmountSats(withLabels([]), RECIPIENT),
    ).resolves.toMatchObject({ amountSats: 1500 });
  });

  test('no org base and no override is a 503 for everyone else', async () => {
    mockConfig(
      {},
      { overrides: { [OID]: { githubPrMerged: { baseSats: 1500 } } } },
    );

    await expect(
      resolveAmountSats(withLabels([]), {
        personAad: 'aaaaaaaa-2222-3333-4444-555555555555',
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  test('the highest matching level wins and unknown labels are ignored', async () => {
    mockConfig({ githubPrMergedSats: 1000 }, { levels });

    await expect(
      resolveAmountSats(
        withLabels(['bug', 'reward:L1', 'reward:L3', 'reward:L9']),
        RECIPIENT,
      ),
    ).resolves.toEqual({
      amountSats: 2000,
      baseSats: 1000,
      bonusSats: 1000,
      level: 'L3',
    });
  });

  test('bonuses are never summed', async () => {
    mockConfig({ githubPrMergedSats: 1000 }, { levels });

    await expect(
      resolveAmountSats(withLabels(['reward:L1', 'reward:L2']), RECIPIENT),
    ).resolves.toMatchObject({ amountSats: 1500, level: 'L2' });
  });

  test('no level configured means no bonus, whatever the labels', async () => {
    mockConfig({ githubPrMergedSats: 1000 });

    await expect(
      resolveAmountSats(withLabels(['reward:L3']), RECIPIENT),
    ).resolves.toMatchObject({ amountSats: 1000, bonusSats: 0, level: null });
  });

  test('an unlinked recipient gets the org base plus the bonus', async () => {
    mockConfig(
      { githubPrMergedSats: 1000 },
      {
        levels,
        overrides: { [OID]: { githubPrMerged: { baseSats: 1500 } } },
      },
    );

    await expect(
      resolveAmountSats(withLabels(['reward:L2']), null),
    ).resolves.toMatchObject({ amountSats: 1500, baseSats: 1000 });
  });

  test('base plus bonus above REWARDS_MAX_AMOUNT_SATS fails closed', async () => {
    mockConfig({ githubPrMergedSats: 9500 }, { levels });

    await expect(
      resolveAmountSats(withLabels(['reward:L3']), RECIPIENT),
    ).rejects.toThrow('configured amount');
  });

  test('a policy fetch failure pays nothing', async () => {
    mockedGetRewardConfig.mockRejectedValue(
      new Error('reward policy response failed validation: budget is invalid'),
    );

    await expect(resolveAmountSats(withLabels([]), RECIPIENT)).rejects.toThrow(
      'failed validation',
    );
  });
});

describe('selectLevel', () => {
  const rule = { labelPrefix: 'reward:', bonuses: { L1: 250, L2: 500 } };

  test('matches labels case-insensitively, as GitHub does', () => {
    expect(selectLevel(['REWARD:l2'], rule)).toEqual({
      level: 'L2',
      bonusSats: 500,
    });
  });

  test('a bare level name without the prefix does not count', () => {
    expect(selectLevel(['L2'], rule)).toBeNull();
  });

  test('no rule means no level', () => {
    expect(selectLevel(['reward:L2'], undefined)).toBeNull();
  });
});

describe('resolveRewardRecipient and the payment extra', () => {
  const savedTreasuryKey = process.env.REWARDS_TREASURY_ADMINKEY;

  afterEach(() => {
    if (savedTreasuryKey === undefined) {
      delete process.env.REWARDS_TREASURY_ADMINKEY;
    } else {
      process.env.REWARDS_TREASURY_ADMINKEY = savedTreasuryKey;
    }
  });

  test('resolves by the GitHub id, never the login', async () => {
    mockedResolveRecipient.mockResolvedValue(RECIPIENT);

    await expect(
      resolveRewardRecipient(parseRewardRequest(validReward)),
    ).resolves.toEqual(RECIPIENT);
    expect(mockedResolveRecipient).toHaveBeenCalledWith('583231');
  });

  test('the payment extra records the base, bonus and level', async () => {
    process.env.REWARDS_TREASURY_ADMINKEY = 'treasury-admin-key';
    mockedCreateInvoice.mockResolvedValue('lnbc-invoice');
    mockedPayInvoice.mockResolvedValue({ payment_hash: 'hash-1' });

    await payReward(
      {
        recipient: 'octocat',
        recipientId: '583231',
        amountSats: 1500,
        baseSats: 1000,
        bonusSats: 500,
        level: 'L2',
        eventType: 'githubPrMerged',
        repo: 'octo-org/octo-repo',
        reason: 'GitHub: PR #7 merged',
        source: 'github',
      },
      RECIPIENT,
    );

    expect(mockedPayInvoice).toHaveBeenCalledWith(
      'treasury-admin-key',
      'lnbc-invoice',
      expect.objectContaining({
        automation: true,
        baseSats: 1000,
        bonusSats: 500,
        level: 'L2',
      }),
    );
  });
});
