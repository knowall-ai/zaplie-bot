import { getAllPayments } from '../services/lnbits/payments';
import { getUsers } from '../services/lnbits/users';
import { getUserWallets } from '../services/lnbits/wallets';
import { fetchZapActivity } from './walletUtilities';

jest.mock('../services/lnbits/payments', () => ({
  getAllPayments: jest.fn(),
}));
jest.mock('../services/lnbits/users', () => ({
  getUsers: jest.fn(),
}));
jest.mock('../services/lnbits/wallets', () => ({
  getUserWallets: jest.fn(),
}));

const user = (id: string): User => ({
  id,
  displayName: id,
  profileImg: '',
  aadObjectId: `aad-${id}`,
  email: `${id}@example.test`,
  type: 'Teammate',
  privateWallet: null,
  allowanceWallet: null,
});

const wallet = (id: string, name: string, owner: string): Wallet => ({
  id,
  name,
  user: owner,
  balance_msat: 0,
  deleted: false,
});

const payment = (
  checkingId: string,
  walletId: string,
  amount: number,
  time: number,
): Transaction => ({
  checking_id: checkingId,
  pending: false,
  amount,
  fee: 0,
  memo: 'Thanks',
  time,
  extra: {},
  wallet_id: walletId,
});

describe('fetchZapActivity', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns only paired Allowance-to-Private transfers between users', async () => {
    const alex = user('alex');
    const sam = user('sam');
    (getUsers as jest.Mock).mockResolvedValue([alex, sam]);
    (getUserWallets as jest.Mock).mockImplementation(async (id: string) =>
      id === 'alex'
        ? [wallet('alex-a', ' allowance ', id), wallet('alex-p', 'private', id)]
        : [wallet('sam-a', 'ALLOWANCE', id), wallet('sam-p', 'Private', id)],
    );
    (getAllPayments as jest.Mock).mockResolvedValue([
      payment('internal_valid', 'alex-a', -20_000, 10),
      payment('valid', 'sam-p', 20_000, 10),
      payment('external', 'alex-a', -10_000, 20),
      payment('internal_self', 'sam-a', -5_000, 30),
      payment('self', 'sam-p', 5_000, 30),
    ]);

    const result = await fetchZapActivity();

    expect(result.users).toEqual([alex, sam]);
    expect(result.transfers).toEqual([
      expect.objectContaining({
        from: alex,
        to: sam,
        transaction: expect.objectContaining({ checking_id: 'internal_valid' }),
      }),
    ]);
  });

  test('rejects instead of presenting partial wallet data', async () => {
    (getUsers as jest.Mock).mockResolvedValue([user('alex')]);
    (getUserWallets as jest.Mock).mockRejectedValue(new Error('LNbits down'));

    await expect(fetchZapActivity()).rejects.toThrow('LNbits down');
    expect(getAllPayments).not.toHaveBeenCalled();
  });

  test('skips ambiguous and mismatched payment pairs', async () => {
    const alex = user('alex');
    const sam = user('sam');
    (getUsers as jest.Mock).mockResolvedValue([alex, sam]);
    (getUserWallets as jest.Mock).mockImplementation(async (id: string) =>
      id === 'alex'
        ? [wallet('alex-a', 'Allowance', id)]
        : [wallet('sam-p', 'Private', id)],
    );
    (getAllPayments as jest.Mock).mockResolvedValue([
      payment('internal_ambiguous', 'alex-a', -20_000, 10),
      payment('ambiguous', 'sam-p', 20_000, 10),
      payment('ambiguous', 'sam-p', 20_000, 10),
      payment('internal_mismatch', 'alex-a', -10_000, 20),
      payment('mismatch', 'sam-p', 9_000, 20),
    ]);

    await expect(fetchZapActivity()).resolves.toEqual({
      users: [alex, sam],
      transfers: [],
    });
  });

  test('skips a wallet with conflicting owners instead of blanking the page', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const alex = user('alex');
    const sam = user('sam');
    (getUsers as jest.Mock).mockResolvedValue([alex, sam]);
    (getUserWallets as jest.Mock).mockImplementation(async (id: string) =>
      id === 'alex'
        ? [
            wallet('alex-a', 'Allowance', id),
            // Claimed by both users: the directory contradicts itself.
            wallet('shared-wallet', 'Private', id),
          ]
        : [
            wallet('shared-wallet', 'Private', id),
            wallet('sam-p', 'Private', id),
          ],
    );
    (getAllPayments as jest.Mock).mockResolvedValue([
      payment('internal_valid', 'alex-a', -20_000, 10),
      payment('valid', 'sam-p', 20_000, 10),
    ]);

    // Feed, Leaderboard and the stat cards all read this one call, so one
    // contradictory row must not take all three down.
    const result = await fetchZapActivity();

    expect(result.transfers).toEqual([
      expect.objectContaining({
        from: alex,
        to: sam,
        transaction: expect.objectContaining({ checking_id: 'internal_valid' }),
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      'Skipped a wallet with conflicting owners:',
      'wallet_id=shared-wallet',
      'kept=alex',
      'ignored=sam',
    );
    warn.mockRestore();
  });
});
