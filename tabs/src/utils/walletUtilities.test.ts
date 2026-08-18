import {
  getAllPayments,
  getUsers,
  getUserWallets,
} from '../services/lnbitsServiceLocal';
import { fetchZapActivity } from './walletUtilities';

jest.mock('../services/lnbitsServiceLocal', () => ({
  getAllPayments: jest.fn(),
  getUsers: jest.fn(),
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

  test('rejects conflicting wallet ownership', async () => {
    const alex = user('alex');
    const sam = user('sam');
    (getUsers as jest.Mock).mockResolvedValue([alex, sam]);
    (getUserWallets as jest.Mock).mockImplementation(async (id: string) => [
      wallet('shared-wallet', 'Allowance', id),
    ]);

    await expect(fetchZapActivity()).rejects.toThrow(
      'Wallet shared-wallet has conflicting owners.',
    );
    expect(getAllPayments).not.toHaveBeenCalled();
  });
});
