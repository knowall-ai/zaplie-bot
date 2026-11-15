import { resolveRewardRecipientByGithubId } from './identityService';
import {
  payReward,
  resolveRewardRecipient,
  RewardPaymentUncertainError,
} from './rewardsService';
import {
  payReward as payRewardThroughPortal,
  PaymentNotSentError,
  PaymentOutcomeUncertainError,
} from './peopleDirectory';
import { createPendingReward } from './pendingRewardsService';
import {
  expect,
  describe,
  test,
  beforeEach,
  afterAll,
  jest,
} from '@jest/globals';

jest.mock('./peopleDirectory', () => {
  const actual =
    jest.requireActual<typeof import('./peopleDirectory')>('./peopleDirectory');
  return { ...actual, payReward: jest.fn() };
});
jest.mock('./pendingRewardsService');

const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch as unknown as typeof fetch;

const originalTabBackendToken = process.env.TAB_BACKEND_TOKEN;

afterAll(() => {
  if (originalTabBackendToken === undefined) {
    delete process.env.TAB_BACKEND_TOKEN;
  } else {
    process.env.TAB_BACKEND_TOKEN = originalTabBackendToken;
  }
});

const mockedPayInvoice = payRewardThroughPortal as jest.MockedFunction<
  typeof payRewardThroughPortal
>;
const mockedCreatePendingReward = createPendingReward as jest.MockedFunction<
  typeof createPendingReward
>;

describe('resolveRewardRecipientByGithubId', () => {
  beforeEach(() => {
    process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
    jest.clearAllMocks();
  });

  test('returns the linked person by Entra object id', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ personAad: 'aad-1' }),
    } as Response);

    await expect(resolveRewardRecipientByGithubId('12345678')).resolves.toEqual(
      { personAad: 'aad-1' },
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(
        '/identities/resolve?provider=github&providerId=12345678',
      ),
      expect.objectContaining({
        headers: { Authorization: 'test-internal-token' },
      }),
    );
  });

  test('returns null when the tab backend has no link for that id (404)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'no identity linked' }),
    } as Response);

    await expect(
      resolveRewardRecipientByGithubId('99999999'),
    ).resolves.toBeNull();
  });

  test('throws on an unexpected non-404 error status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    await expect(resolveRewardRecipientByGithubId('12345678')).rejects.toThrow(
      'identity resolve failed: 500',
    );
  });

  test('fails loud when the backend omits the person', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ personAad: '' }),
    } as Response);

    await expect(resolveRewardRecipientByGithubId('12345678')).rejects.toThrow(
      'identity resolve returned an invalid recipient',
    );
  });
});

// The pipeline resolves the recipient first, then pays with the result.
const payResolved = async (
  reward: Parameters<typeof payReward>[0],
): ReturnType<typeof payReward> =>
  payReward(reward, await resolveRewardRecipient(reward));

describe('payReward recipientId resolution', () => {
  const rewardWithRecipientId = {
    recipient: 'octocat',
    recipientId: '12345678',
    amountSats: 210,
    reason: 'GitHub: PR #7 merged',
    source: 'github',
  };

  const linkResolves = () =>
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ personAad: 'aad-1' }),
    } as Response);

  const linkMissing = () =>
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
    process.env.REWARDS_TREASURY_ADMINKEY = 'treasury-adminkey';
  });

  test('resolves the recipient via the identity graph and pays', async () => {
    linkResolves();
    mockedPayInvoice.mockResolvedValue('hash-1');

    const result = await payResolved(rewardWithRecipientId);

    expect(result).toEqual({ paymentHash: 'hash-1' });
    expect(mockedPayInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientOid: 'aad-1',
        recipientLabel: 'octocat',
        amountSats: 210,
        memo: 'GitHub: PR #7 merged',
      }),
    );
    expect(mockedCreatePendingReward).not.toHaveBeenCalled();
  });

  test('names the recipient by Entra id and sends no invoice or address', async () => {
    linkResolves();
    mockedPayInvoice.mockResolvedValue('hash-1');

    await payResolved(rewardWithRecipientId);

    const request = mockedPayInvoice.mock.calls[0][0];
    expect(Object.keys(request).sort()).toEqual(
      [
        'amountSats',
        'idempotencyKey',
        'memo',
        'recipientLabel',
        'recipientOid',
        'reward',
      ].sort(),
    );
    expect(request.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  test('holds the reward pending when the recipient has not linked their GitHub', async () => {
    linkMissing();
    mockedCreatePendingReward.mockResolvedValue(undefined);

    const result = await payResolved(rewardWithRecipientId);

    expect(result).toEqual({ pending: true });
    expect(mockedCreatePendingReward).toHaveBeenCalledWith({
      provider: 'github',
      providerId: '12345678',
      recipientLabel: 'octocat',
      amountSats: 210,
      reason: 'GitHub: PR #7 merged',
      source: 'github',
    });
    expect(mockedPayInvoice).not.toHaveBeenCalled();
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('fails loud when server-side LNbits identity resolution errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'LNbits unavailable' }),
    } as Response);

    await expect(payResolved(rewardWithRecipientId)).rejects.toThrow(
      'identity resolve failed: 502',
    );
    expect(mockedCreatePendingReward).not.toHaveBeenCalled();
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('throws when a linked-person response has no person', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);

    await expect(payResolved(rewardWithRecipientId)).rejects.toThrow(
      'identity resolve returned an invalid recipient',
    );
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('rejects a reward with no recipientId with a 400', async () => {
    const { recipientId: _omit, ...withoutId } = rewardWithRecipientId;

    await expect(payResolved(withoutId)).rejects.toHaveProperty(
      'statusCode',
      400,
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a recipient with no receive target is refused before any payment', async () => {
    linkResolves();
    mockedPayInvoice.mockRejectedValue(
      new PaymentNotSentError(
        'octocat has not set up where they receive zaps yet',
      ),
    );

    await expect(payResolved(rewardWithRecipientId)).rejects.toThrow(
      PaymentNotSentError,
    );
  });

  test('throws an uncertain outcome when payInvoice returns no payment hash', async () => {
    linkResolves();
    mockedPayInvoice.mockRejectedValue(
      new PaymentOutcomeUncertainError('no payment hash'),
    );

    await expect(payResolved(rewardWithRecipientId)).rejects.toThrow(
      RewardPaymentUncertainError,
    );
  });
});
