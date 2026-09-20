import { getAllPayments } from '../services/lnbits/payments';
import { getUsers } from '../services/lnbits/users';
import { getUserWallets } from '../services/lnbits/wallets';
import {
  fetchVerifiedZapPayments,
  fetchZapActivity,
  PAYMENT_FETCH_CAP,
  PAYMENT_PAGE_SIZE,
} from './walletUtilities';

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
        : [wallet('sam-p', 'Private', id), wallet('sam-p2', 'Private', id)],
    );
    // Three legs on one checking_id is genuinely ambiguous — two of them land
    // in different wallets, so this is not the repeated-read case.
    (getAllPayments as jest.Mock).mockResolvedValue([
      payment('internal_ambiguous', 'alex-a', -20_000, 10),
      payment('ambiguous', 'sam-p', 20_000, 10),
      payment('ambiguous', 'sam-p2', 20_000, 10),
      payment('internal_mismatch', 'alex-a', -10_000, 20),
      payment('mismatch', 'sam-p', 9_000, 20),
    ]);

    await expect(fetchZapActivity()).resolves.toEqual({
      users: [alex, sam],
      transfers: [],
      truncated: false,
    });
  });

  test('excludes the weekly allowance sweep', async () => {
    const alex = user('alex');
    const sam = user('sam');
    (getUsers as jest.Mock).mockResolvedValue([alex, sam]);
    (getUserWallets as jest.Mock).mockImplementation(async (id: string) =>
      id === 'alex'
        ? [wallet('alex-a', 'Allowance', id)]
        : [wallet('sam-p', 'Private', id)],
    );
    const sweepOut = payment('internal_sweep', 'alex-a', -500_000, 10);
    const sweepIn = payment('sweep', 'sam-p', 500_000, 10);
    sweepOut.memo = 'Weekly Allowance cleared';
    sweepIn.memo = 'Weekly Allowance cleared';
    (getAllPayments as jest.Mock).mockResolvedValue([sweepOut, sweepIn]);

    const result = await fetchZapActivity();

    expect(result.transfers).toEqual([]);
  });

  test('pages until the requested window is covered', async () => {
    const alex = user('alex');
    const sam = user('sam');
    (getUsers as jest.Mock).mockResolvedValue([alex, sam]);
    (getUserWallets as jest.Mock).mockImplementation(async (id: string) =>
      id === 'alex'
        ? [wallet('alex-a', 'Allowance', id)]
        : [wallet('sam-p', 'Private', id)],
    );

    // A full first page keeps paging; the second reaches past the window.
    const firstPage = Array.from(
      { length: PAYMENT_PAGE_SIZE },
      (_unused, index) => payment(`recent-${index}`, 'alex-a', -1_000, 5_000),
    );
    (getAllPayments as jest.Mock)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([payment('older', 'alex-a', -1_000, 10)]);

    const result = await fetchZapActivity(1_000);

    expect(getAllPayments).toHaveBeenCalledTimes(2);
    expect(getAllPayments).toHaveBeenNthCalledWith(1, PAYMENT_PAGE_SIZE, 0);
    expect(getAllPayments).toHaveBeenNthCalledWith(
      2,
      PAYMENT_PAGE_SIZE,
      PAYMENT_PAGE_SIZE,
    );
    expect(result.truncated).toBe(false);
  });

  test('reports truncation when the fetch cap is reached first', async () => {
    const alex = user('alex');
    (getUsers as jest.Mock).mockResolvedValue([alex]);
    (getUserWallets as jest.Mock).mockResolvedValue([
      wallet('alex-a', 'Allowance', 'alex'),
    ]);

    // Every page is full and every row is inside the window, so paging only
    // stops at the cap — the caller has to be told the list is incomplete.
    (getAllPayments as jest.Mock).mockImplementation(async () =>
      Array.from({ length: PAYMENT_PAGE_SIZE }, (_unused, index) =>
        payment(`row-${index}`, 'alex-a', -1_000, 5_000),
      ),
    );

    const result = await fetchZapActivity(1_000);

    expect(getAllPayments).toHaveBeenCalledTimes(
      PAYMENT_FETCH_CAP / PAYMENT_PAGE_SIZE,
    );
    expect(result.truncated).toBe(true);
  });

  test('keeps a pair whose leg repeats across a page boundary', async () => {
    const alex = user('alex');
    const sam = user('sam');
    (getUsers as jest.Mock).mockResolvedValue([alex, sam]);
    (getUserWallets as jest.Mock).mockImplementation(async (id: string) =>
      id === 'alex'
        ? [wallet('alex-a', 'Allowance', id)]
        : [wallet('sam-p', 'Private', id)],
    );

    // /payments is live, so a write between the two reads shifts the list down
    // and hands the same outgoing leg back on the second page.
    const outgoing = payment('internal_valid', 'alex-a', -20_000, 5_000);
    const firstPage = [
      ...Array.from({ length: PAYMENT_PAGE_SIZE - 1 }, (_unused, index) =>
        payment(`filler-${index}`, 'alex-a', -1_000, 5_000),
      ),
      outgoing,
    ];
    (getAllPayments as jest.Mock)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([
        outgoing,
        payment('valid', 'sam-p', 20_000, 5_000),
        payment('older', 'alex-a', -1_000, 10),
      ]);

    const result = await fetchZapActivity(1_000);

    expect(result.transfers).toEqual([
      expect.objectContaining({
        from: alex,
        to: sam,
        transaction: expect.objectContaining({ checking_id: 'internal_valid' }),
      }),
    ]);
  });

  test('rejects a window that is not a whole number of seconds', async () => {
    (getUsers as jest.Mock).mockResolvedValue([user('alex')]);
    (getUserWallets as jest.Mock).mockResolvedValue([
      wallet('alex-a', 'Allowance', 'alex'),
    ]);

    for (const invalid of [Number.NaN, -1, 1_700_000_000.5, Infinity]) {
      await expect(fetchZapActivity(invalid)).rejects.toThrow(
        'A zap history window must be a whole, non-negative number of seconds.',
      );
    }

    // Refused before any network call, so nothing half-read is reported.
    expect(getUsers).not.toHaveBeenCalled();
    expect(getAllPayments).not.toHaveBeenCalled();
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

describe('fetchVerifiedZapPayments', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns one outgoing leg per verified zap, not both sides', async () => {
    const alex = user('alex');
    const sam = user('sam');
    (getUsers as jest.Mock).mockResolvedValue([alex, sam]);
    (getUserWallets as jest.Mock).mockImplementation(async (id: string) =>
      id === 'alex'
        ? [wallet('alex-a', 'Allowance', id)]
        : [wallet('sam-p', 'Private', id)],
    );
    (getAllPayments as jest.Mock).mockResolvedValue([
      payment('internal_valid', 'alex-a', -20_000, 10),
      payment('valid', 'sam-p', 20_000, 10),
      payment('internal_newer', 'alex-a', -5_000, 40),
      payment('newer', 'sam-p', 5_000, 40),
      // Unpaired, so it is not a verified zap at all.
      payment('external', 'alex-a', -10_000, 20),
    ]);

    const result = await fetchVerifiedZapPayments();

    expect(result.truncated).toBe(false);
    expect(
      result.payments.map(entry => ({
        checking_id: entry.checking_id,
        amount: entry.amount,
      })),
    ).toEqual([
      { checking_id: 'internal_newer', amount: -5_000 },
      { checking_id: 'internal_valid', amount: -20_000 },
    ]);
  });

  test('passes truncation through to its callers', async () => {
    (getUsers as jest.Mock).mockResolvedValue([user('alex')]);
    (getUserWallets as jest.Mock).mockResolvedValue([
      wallet('alex-a', 'Allowance', 'alex'),
    ]);
    (getAllPayments as jest.Mock).mockImplementation(async () =>
      Array.from({ length: PAYMENT_PAGE_SIZE }, (_unused, index) =>
        payment(`row-${index}`, 'alex-a', -1_000, 5_000),
      ),
    );

    await expect(fetchVerifiedZapPayments(1_000)).resolves.toEqual({
      payments: [],
      truncated: true,
    });
  });
});
