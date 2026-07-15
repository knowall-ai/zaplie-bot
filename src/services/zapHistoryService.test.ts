// zapHistoryService.test.ts
//
// Mocks lnbitsService (an external dependency of the module under test), not
// zapHistoryService itself — the matching/filtering logic being tested here
// lives entirely in zapHistoryService.

import { getRecentZaps } from './zapHistoryService';
import { getUsers, getUserWallets, getPayments } from './lnbitsService';
import { expect, describe, test, beforeEach, jest } from '@jest/globals';

jest.mock('./lnbitsService');

const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;
const mockGetUserWallets = getUserWallets as jest.MockedFunction<typeof getUserWallets>;
const mockGetPayments = getPayments as jest.MockedFunction<typeof getPayments>;

const alice: User = {
  id: 'user-alice',
  displayName: 'Alice',
  profileImg: '',
  aadObjectId: 'aad-alice',
  email: 'alice@example.com',
  privateWallet: null,
  allowanceWallet: null,
};

const bob: User = {
  id: 'user-bob',
  displayName: 'Bob',
  profileImg: '',
  aadObjectId: 'aad-bob',
  email: 'bob@example.com',
  privateWallet: null,
  allowanceWallet: null,
};

const aliceAllowance: Wallet = {
  id: 'w-alice-allow',
  admin: '',
  name: 'Allowance',
  user: alice.id,
  adminkey: 'adm-alice-allow',
  inkey: 'ink-alice-allow',
  balance_msat: 900000,
  deleted: false,
};

const alicePrivate: Wallet = {
  id: 'w-alice-priv',
  admin: '',
  name: 'Private',
  user: alice.id,
  adminkey: 'adm-alice-priv',
  inkey: 'ink-alice-priv',
  balance_msat: 0,
  deleted: false,
};

const bobAllowance: Wallet = {
  id: 'w-bob-allow',
  admin: '',
  name: 'Allowance',
  user: bob.id,
  adminkey: 'adm-bob-allow',
  inkey: 'ink-bob-allow',
  balance_msat: 1000000,
  deleted: false,
};

const bobPrivate: Wallet = {
  id: 'w-bob-priv',
  admin: '',
  name: 'Private',
  user: bob.id,
  adminkey: 'adm-bob-priv',
  inkey: 'ink-bob-priv',
  balance_msat: 100000,
  deleted: false,
};

const walletsByInkey: Record<string, Transaction[]> = {};

const setupUsersAndWallets = () => {
  mockGetUsers.mockResolvedValue([alice, bob]);
  mockGetUserWallets.mockImplementation(async (_adminKey, userId) => {
    if (userId === alice.id) return [aliceAllowance, alicePrivate];
    if (userId === bob.id) return [bobAllowance, bobPrivate];
    return [];
  });
  mockGetPayments.mockImplementation(async (inKey: string) =>
    (walletsByInkey[inKey] || []) as any,
  );
};

const tx = (overrides: Partial<Transaction>): Transaction => ({
  checking_id: 'default',
  pending: false,
  amount: 0,
  fee: 0,
  memo: '',
  time: 0,
  extra: {},
  wallet_id: '',
  ...overrides,
});

describe('zapHistoryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(walletsByInkey)) {
      delete walletsByInkey[key];
    }
    setupUsersAndWallets();
  });

  test('matches a zap across the Allowance (debit) and Private (credit) sides by checking_id', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'zap1',
        amount: -100000,
        memo: 'Great work!',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_zap1',
        amount: 100000,
        memo: 'Great work!',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];

    const result = await getRecentZaps();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      amountSats: 100,
      memo: 'Great work!',
    });
    expect(result[0].from?.displayName).toBe('Alice');
    expect(result[0].to?.displayName).toBe('Bob');
  });

  test('excludes scheduled "Weekly Allowance cleared" sweeps', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'sweep1',
        amount: -50000,
        memo: 'Weekly Allowance cleared',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_sweep1',
        amount: 50000,
        memo: 'Weekly Allowance cleared',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];

    const result = await getRecentZaps();

    expect(result).toHaveLength(0);
  });

  test('excludes outgoing Allowance payments with no matching Private-wallet receipt', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'external1',
        amount: -30000,
        memo: 'External lightning payment',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];

    const result = await getRecentZaps();

    expect(result).toHaveLength(0);
  });

  test('deduplicates a single zap seen from both the debit and credit wallet fetch', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'zap1',
        amount: -100000,
        memo: 'Thanks!',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_zap1',
        amount: 100000,
        memo: 'Thanks!',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];
    walletsByInkey[alicePrivate.inkey] = [];
    walletsByInkey[bobAllowance.inkey] = [];

    const result = await getRecentZaps();

    expect(result).toHaveLength(1);
  });

  test('filters out zaps before sinceTimestamp', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'old-zap',
        amount: -10000,
        memo: 'old',
        time: 1000000000,
        wallet_id: aliceAllowance.id,
      }),
      tx({
        checking_id: 'new-zap',
        amount: -20000,
        memo: 'new',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_old-zap',
        amount: 10000,
        memo: 'old',
        time: 1000000000,
        wallet_id: bobPrivate.id,
      }),
      tx({
        checking_id: 'internal_new-zap',
        amount: 20000,
        memo: 'new',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];

    const result = await getRecentZaps({ sinceTimestamp: 1700000000 });

    expect(result).toHaveLength(1);
    expect(result[0].memo).toBe('new');
  });

  test('filters to zaps involving a specific user as either sender or receiver', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'a-to-b',
        amount: -10000,
        memo: 'alice to bob',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobAllowance.inkey] = [
      tx({
        checking_id: 'b-to-a',
        amount: -20000,
        memo: 'bob to alice',
        time: 1750000001,
        wallet_id: bobAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_a-to-b',
        amount: 10000,
        memo: 'alice to bob',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];
    walletsByInkey[alicePrivate.inkey] = [
      tx({
        checking_id: 'internal_b-to-a',
        amount: 20000,
        memo: 'bob to alice',
        time: 1750000001,
        wallet_id: alicePrivate.id,
      }),
    ];

    const result = await getRecentZaps({ userAadObjectId: bob.aadObjectId });

    expect(result).toHaveLength(2);
  });

  test('sorts newest first and respects limit', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({ checking_id: 'z1', amount: -1000, memo: 'first', time: 100, wallet_id: aliceAllowance.id }),
      tx({ checking_id: 'z2', amount: -1000, memo: 'second', time: 200, wallet_id: aliceAllowance.id }),
      tx({ checking_id: 'z3', amount: -1000, memo: 'third', time: 300, wallet_id: aliceAllowance.id }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({ checking_id: 'internal_z1', amount: 1000, memo: 'first', time: 100, wallet_id: bobPrivate.id }),
      tx({ checking_id: 'internal_z2', amount: 1000, memo: 'second', time: 200, wallet_id: bobPrivate.id }),
      tx({ checking_id: 'internal_z3', amount: 1000, memo: 'third', time: 300, wallet_id: bobPrivate.id }),
    ];

    const result = await getRecentZaps({ limit: 2 });

    expect(result).toHaveLength(2);
    expect(result[0].memo).toBe('third');
    expect(result[1].memo).toBe('second');
  });

  test('returns an empty array when there are no users', async () => {
    mockGetUsers.mockResolvedValue([]);

    const result = await getRecentZaps();

    expect(result).toEqual([]);
  });
});
