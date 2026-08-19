import { scheduledTopup, WeeklyAllowanceDependencies } from './lnbitsService';

const wallet = (id: string, user: string, balanceMsat: number): Wallet => ({
  id,
  user,
  admin: `admin-${id}`,
  name: 'Allowance',
  adminkey: `admin-key-${id}`,
  inkey: `invoice-key-${id}`,
  balance_msat: balanceMsat,
  deleted: false,
});

const member = (id: string, displayName: string): User => ({
  id,
  displayName,
  profileImg: '',
  aadObjectId: `aad-${id}`,
  email: `${id}@example.test`,
  allowanceWallet: null,
  privateWallet: null,
});

const hostWallet = wallet('treasury-wallet', 'treasury-user', 0);

const originalEnv = { ...process.env };

const createDependencies = (): jest.Mocked<WeeklyAllowanceDependencies> => {
  const dependencies: jest.Mocked<WeeklyAllowanceDependencies> = {
    getWallets: jest.fn(),
    getUser: jest.fn(),
    getWalletById: jest.fn(),
    createInvoice: jest.fn(),
    payInvoice: jest.fn(),
    topUpWallet: jest.fn(),
  };
  dependencies.getWalletById.mockResolvedValue(hostWallet);
  return dependencies;
};

beforeEach(() => {
  process.env.LNBITS_NODE_URL = 'https://lnbits.example.test';
  process.env.LNBITS_ADMINKEY = 'server-admin-key';
  process.env.LNBITS_INKEY = 'treasury-invoice-key';
  process.env.LNBITS_HOST_WALLET_ID = 'treasury-wallet';
  process.env.LNBITS_HOST_USER_ID = 'treasury-user';
  process.env.LNBITS_INITIAL_ALLOWANCE = '25000';
});

afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

describe('scheduledTopup', () => {
  test('clears and refills each allowance wallet in order', async () => {
    const first = wallet('wallet-1', 'user-1', 20000);
    const second = wallet('wallet-2', 'user-2', 0);
    const dependencies = createDependencies();
    const calls: string[] = [];

    dependencies.getWallets.mockResolvedValue([first, second]);
    dependencies.getUser.mockImplementation(async (_adminKey, userId) =>
      userId === 'user-1'
        ? member('user-1', 'Alex Rivera')
        : member('user-2', 'Dana Kowalski'),
    );
    dependencies.createInvoice.mockImplementation(async () => {
      calls.push('invoice:wallet-1');
      return 'lnbc-invoice';
    });
    dependencies.payInvoice.mockImplementation(async () => {
      calls.push('payment:wallet-1');
      return { checking_id: 'payment-1' };
    });
    dependencies.topUpWallet.mockImplementation(async walletId => {
      calls.push(`topup:${walletId}`);
    });

    const summary = await scheduledTopup(dependencies);

    expect(calls).toEqual([
      'invoice:wallet-1',
      'payment:wallet-1',
      'topup:wallet-1',
      'topup:wallet-2',
    ]);
    expect(summary).toEqual({
      wallets: 2,
      swept: 1,
      toppedUp: 2,
      failures: [],
      warnings: [],
    });
    expect(dependencies.getWallets).toHaveBeenCalledWith(
      'server-admin-key',
      'Allowance',
    );
    expect(dependencies.getWalletById).toHaveBeenCalledWith(
      'treasury-user',
      'treasury-wallet',
    );
    expect(dependencies.createInvoice).toHaveBeenCalledWith(
      'treasury-invoice-key',
      'treasury-wallet',
      20,
      'Alex Rivera Weekly Allowance cleared',
      { from: first, to: hostWallet, tag: 'zap' },
    );
    expect(dependencies.topUpWallet).toHaveBeenNthCalledWith(
      1,
      'wallet-1',
      25000,
    );
    expect(dependencies.topUpWallet).toHaveBeenNthCalledWith(
      2,
      'wallet-2',
      25000,
    );
  });

  test('validates all configuration before loading wallets', async () => {
    const dependencies = createDependencies();
    delete process.env.LNBITS_HOST_WALLET_ID;

    await expect(scheduledTopup(dependencies)).rejects.toThrow(
      'LNBITS_HOST_WALLET_ID is not set',
    );
    expect(dependencies.getWallets).not.toHaveBeenCalled();
  });

  test('rejects an invalid allowance before loading wallets', async () => {
    const dependencies = createDependencies();
    process.env.LNBITS_INITIAL_ALLOWANCE = '25.5';

    await expect(scheduledTopup(dependencies)).rejects.toThrow(
      'LNBITS_INITIAL_ALLOWANCE must be a positive integer',
    );
    expect(dependencies.getWallets).not.toHaveBeenCalled();
  });

  test('fails closed when the wallet directory is unavailable', async () => {
    const dependencies = createDependencies();
    dependencies.getWallets.mockResolvedValue(null);

    await expect(scheduledTopup(dependencies)).rejects.toThrow(
      'Unable to load allowance wallets',
    );
    expect(dependencies.topUpWallet).not.toHaveBeenCalled();
  });

  test('fails closed when the treasury wallet cannot be resolved', async () => {
    const dependencies = createDependencies();
    dependencies.getWallets.mockResolvedValue([]);
    dependencies.getWalletById.mockResolvedValue(null);

    await expect(scheduledTopup(dependencies)).rejects.toThrow(
      'Unable to load treasury wallet',
    );
    expect(dependencies.topUpWallet).not.toHaveBeenCalled();
  });

  test('does not move or add funds when the owner cannot be resolved', async () => {
    const dependencies = createDependencies();
    dependencies.getWallets.mockResolvedValue([
      wallet('missing-owner-wallet', 'missing-user', 20000),
    ]);
    dependencies.getUser.mockResolvedValue(null);

    const summary = await scheduledTopup(dependencies);

    expect(summary.failures).toEqual([
      {
        walletId: 'missing-owner-wallet',
        error: 'Allowance owner not found for wallet missing-owner-wallet',
      },
    ]);
    expect(dependencies.createInvoice).not.toHaveBeenCalled();
    expect(dependencies.payInvoice).not.toHaveBeenCalled();
    expect(dependencies.topUpWallet).not.toHaveBeenCalled();
  });

  test('does not top up a wallet whose outgoing payment failed, but continues', async () => {
    const dependencies = createDependencies();
    dependencies.getWallets.mockResolvedValue([
      wallet('wallet-1', 'user-1', 20000),
      wallet('wallet-2', 'user-2', 0),
    ]);
    dependencies.getUser.mockImplementation(async (_adminKey, userId) =>
      userId === 'user-1'
        ? member('user-1', 'Alex Rivera')
        : member('user-2', 'Dana Kowalski'),
    );
    dependencies.createInvoice.mockResolvedValue('lnbc-invoice');
    dependencies.payInvoice.mockRejectedValue(new Error('payment failed'));

    const summary = await scheduledTopup(dependencies);

    expect(summary).toEqual({
      wallets: 2,
      swept: 0,
      toppedUp: 1,
      failures: [{ walletId: 'wallet-1', error: 'payment failed' }],
      warnings: [],
    });
    expect(dependencies.topUpWallet).toHaveBeenCalledTimes(1);
    expect(dependencies.topUpWallet).toHaveBeenCalledWith('wallet-2', 25000);
  });

  test('sweeps a sub-sat balance down to whole sats and warns', async () => {
    const dependencies = createDependencies();
    dependencies.getWallets.mockResolvedValue([
      wallet('wallet-1', 'user-1', 20500),
    ]);
    dependencies.getUser.mockResolvedValue(member('user-1', 'Alex Rivera'));
    dependencies.createInvoice.mockResolvedValue('lnbc-invoice');
    dependencies.payInvoice.mockResolvedValue({ checking_id: 'payment-1' });

    const summary = await scheduledTopup(dependencies);

    // Excluding the wallet would leave it permanently above its allowance.
    expect(summary.failures).toEqual([]);
    expect(summary.swept).toBe(1);
    expect(summary.toppedUp).toBe(1);
    expect(summary.warnings).toEqual([
      {
        walletId: 'wallet-1',
        warning:
          'Balance is not a whole number of sats; swept 20 sats and left 500 msat',
      },
    ]);
    expect(dependencies.createInvoice).toHaveBeenCalledWith(
      'treasury-invoice-key',
      'treasury-wallet',
      20,
      'Alex Rivera Weekly Allowance cleared',
      expect.anything(),
    );
    expect(dependencies.topUpWallet).toHaveBeenCalledWith('wallet-1', 25000);
  });

  test('rejects a balance that is not a usable number', async () => {
    const dependencies = createDependencies();
    dependencies.getWallets.mockResolvedValue([
      wallet('wallet-1', 'user-1', -1),
    ]);
    dependencies.getUser.mockResolvedValue(member('user-1', 'Alex Rivera'));

    const summary = await scheduledTopup(dependencies);

    expect(summary.failures).toEqual([
      {
        walletId: 'wallet-1',
        error: 'Invalid balance for allowance wallet wallet-1',
      },
    ]);
    expect(dependencies.createInvoice).not.toHaveBeenCalled();
    expect(dependencies.topUpWallet).not.toHaveBeenCalled();
  });
});
