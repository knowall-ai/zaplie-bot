import { resolveRewardRecipientByGithubId } from './identityService';
import { payReward } from './rewardsService';
import {
  getUserWalletsByUserId,
  createInvoice,
  payInvoice,
} from './lnbitsService';
import { createPendingReward } from './pendingRewardsService';
import {
  expect,
  describe,
  test,
  beforeEach,
  afterAll,
  jest,
} from '@jest/globals';

jest.mock('./lnbitsService');
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

const mockedGetUserWallets = getUserWalletsByUserId as jest.MockedFunction<
  typeof getUserWalletsByUserId
>;
const mockedCreateInvoice = createInvoice as jest.MockedFunction<
  typeof createInvoice
>;
const mockedPayInvoice = payInvoice as jest.MockedFunction<typeof payInvoice>;
const mockedCreatePendingReward = createPendingReward as jest.MockedFunction<
  typeof createPendingReward
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

describe('resolveRewardRecipientByGithubId', () => {
  beforeEach(() => {
    process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
    jest.clearAllMocks();
    process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
  });

  test('returns the linked person and server-resolved LNbits user id', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ personAad: 'aad-1', lnbitsUserId: 'lnbits-user-1' }),
    } as Response);

    await expect(resolveRewardRecipientByGithubId('12345678')).resolves.toEqual(
      {
        personAad: 'aad-1',
        lnbitsUserId: 'lnbits-user-1',
      },
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

  test('fails loud when the backend omits the LNbits user id', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ personAad: 'aad-1' }),
    } as Response);

    await expect(resolveRewardRecipientByGithubId('12345678')).rejects.toThrow(
      'identity resolve returned an invalid recipient',
    );
  });
});

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
      json: async () => ({ personAad: 'aad-1', lnbitsUserId: 'lnbits-user-1' }),
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
    mockedGetUserWallets.mockResolvedValue([privateWallet]);
    mockedCreateInvoice.mockResolvedValue('lnbc-payment-request');
    mockedPayInvoice.mockResolvedValue({ payment_hash: 'hash-1' });

    const result = await payReward(rewardWithRecipientId);

    expect(result).toEqual({ paymentHash: 'hash-1' });
    expect(mockedGetUserWallets).toHaveBeenCalledWith('lnbits-user-1');
    expect(mockedCreatePendingReward).not.toHaveBeenCalled();
  });

  test('does not embed wallet keys in the payment extra', async () => {
    linkResolves();
    mockedGetUserWallets.mockResolvedValue([privateWallet]);
    mockedCreateInvoice.mockResolvedValue('lnbc-payment-request');
    mockedPayInvoice.mockResolvedValue({ payment_hash: 'hash-1' });

    await payReward(rewardWithRecipientId);

    const extra = mockedCreateInvoice.mock.calls[0][4];
    expect(JSON.stringify(extra)).not.toContain('adminkey');
    expect(JSON.stringify(extra)).not.toContain('inkey');
    expect(extra).toEqual(
      expect.objectContaining({
        to: expect.objectContaining({ displayName: 'octocat' }),
      }),
    );
  });

  test('holds the reward pending when the recipient has not linked their GitHub', async () => {
    linkMissing();
    mockedCreatePendingReward.mockResolvedValue(undefined);

    const result = await payReward(rewardWithRecipientId);

    expect(result).toEqual({ pending: true });
    expect(mockedCreatePendingReward).toHaveBeenCalledWith({
      provider: 'github',
      providerId: '12345678',
      recipientLabel: 'octocat',
      amountSats: 210,
      reason: 'GitHub: PR #7 merged',
      source: 'github',
    });
    expect(mockedGetUserWallets).not.toHaveBeenCalled();
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('fails loud when server-side LNbits identity resolution errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'LNbits unavailable' }),
    } as Response);

    await expect(payReward(rewardWithRecipientId)).rejects.toThrow(
      'identity resolve failed: 502',
    );
    expect(mockedCreatePendingReward).not.toHaveBeenCalled();
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('throws when a linked-person response has no LNbits user', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ personAad: 'aad-1' }),
    } as Response);

    await expect(payReward(rewardWithRecipientId)).rejects.toThrow(
      'identity resolve returned an invalid recipient',
    );
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('throws a clear error when the LNbits user lookup returns null', async () => {
    linkResolves();
    mockedGetUsers.mockResolvedValue(null);

    await expect(payReward(rewardWithRecipientId)).rejects.toThrow(
      'has no LNbits user',
    );
    expect(mockedGetUserWallets).not.toHaveBeenCalled();
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('validates LNBITS_ADMINKEY before looking up an LNbits user', async () => {
    linkResolves();
    delete process.env.LNBITS_ADMINKEY;

    await expect(payReward(rewardWithRecipientId)).rejects.toThrow(
      'LNBITS_ADMINKEY is not set',
    );
    expect(mockedGetUsers).not.toHaveBeenCalled();
    expect(mockedGetUserWallets).not.toHaveBeenCalled();
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('rejects a reward with no recipientId with a 400', async () => {
    const { recipientId: _omit, ...withoutId } = rewardWithRecipientId;

    await expect(payReward(withoutId)).rejects.toHaveProperty(
      'statusCode',
      400,
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('throws when the recipient has no Private wallet', async () => {
    linkResolves();
    mockedGetUserWallets.mockResolvedValue([
      { ...privateWallet, name: 'Allowance' },
    ]);

    await expect(payReward(rewardWithRecipientId)).rejects.toThrow(
      'has no Private wallet',
    );
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('throws when createInvoice returns an error instead of a bolt11', async () => {
    linkResolves();
    mockedGetUserWallets.mockResolvedValue([privateWallet]);
    mockedCreateInvoice.mockResolvedValue(new Error('lnbits down'));

    await expect(payReward(rewardWithRecipientId)).rejects.toThrow(
      'creating reward invoice failed',
    );
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('throws when payInvoice returns no payment hash', async () => {
    linkResolves();
    mockedGetUserWallets.mockResolvedValue([privateWallet]);
    mockedCreateInvoice.mockResolvedValue('lnbc-payment-request');
    mockedPayInvoice.mockResolvedValue({ detail: 'insufficient balance' });

    await expect(payReward(rewardWithRecipientId)).rejects.toThrow(
      'paying reward invoice failed',
    );
  });
});
