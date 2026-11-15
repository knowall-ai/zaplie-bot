// zapHistoryService.test.ts
//
// Mocks lnbitsService and peopleDirectory (external dependencies of the module
// under test), not zapHistoryService itself — the matching/filtering logic
// being tested here lives entirely in zapHistoryService.
//
// Since the least-privilege redesign only the sending side of a zap is
// visible: every Allowance wallet belongs to zaplie.service, every Private
// wallet to its owner. A zap is an outgoing Allowance payment carrying
// Zaplie's zap metadata, the recipient named by Entra id in `extra.to.user`.

import {
  getRecentZaps,
  getZapLeaderboard,
  MAX_CONCURRENT_LNBITS_REQUESTS,
  PAYMENTS_PAGE_SIZE,
  getZapActivity,
} from './zapHistoryService';
import {
  getPayments,
  getAllPaymentsPage,
  PaginatedPaymentsUnsupportedError,
} from './lnbitsService';
import { listPeople } from './peopleDirectory';
import { expect, describe, test, beforeEach, jest } from '@jest/globals';

jest.mock('./lnbitsService');
jest.mock('./peopleDirectory');

const mockListPeople = listPeople as jest.MockedFunction<typeof listPeople>;
const mockGetPayments = getPayments as jest.MockedFunction<typeof getPayments>;
const mockGetAllPaymentsPage = getAllPaymentsPage as jest.MockedFunction<
  typeof getAllPaymentsPage
>;

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const CAROL = 'cccccccc-0000-4000-8000-000000000003';

const allowance = (oid: string, id: string): Wallet => ({
  id,
  admin: '',
  name: 'Allowance',
  user: oid,
  adminkey: '',
  inkey: `ink-${id}`,
  deleted: false,
});

const person = (oid: string, displayName: string, walletId?: string): User => ({
  id: oid,
  displayName,
  profileImg: '',
  aadObjectId: oid,
  email: '',
  allowanceWallet: walletId ? allowance(oid, walletId) : null,
  canReceive: true,
});

const alice = person(ALICE, 'Alice', 'w-alice');
const bob = person(BOB, 'Bob', 'w-bob');
// Carol can receive but has no Allowance wallet yet (awaiting an operator).
const carol = person(CAROL, 'Carol');

const zapExtra = (from: User, to: string) => ({
  tag: 'zap',
  from: { id: from.allowanceWallet?.id, name: 'Allowance', user: from.id },
  to: { name: 'Private', user: to, displayName: to },
});

let counter = 0;
const zap = (
  from: User,
  to: string,
  sats: number,
  time: number,
  overrides: Partial<Transaction> = {},
): Transaction => ({
  checking_id: `pay-${(counter += 1)}`,
  pending: false,
  amount: -sats * 1000,
  fee: 0,
  memo: 'thanks',
  time,
  extra: zapExtra(from, to),
  wallet_id: from.allowanceWallet?.id as string,
  ...overrides,
});

let payments: Transaction[] = [];

const usePaginated = () => {
  mockGetAllPaymentsPage.mockImplementation(async (limit, offset) =>
    payments.slice(offset, offset + limit),
  );
};

// Force the per-wallet fallback: no LNBITS_API_TOKEN. The error is built from
// the mocked class so the module's `instanceof` check still recognises it.
const useWalletFallback = () => {
  mockGetAllPaymentsPage.mockRejectedValue(
    new PaginatedPaymentsUnsupportedError(0),
  );
  mockGetPayments.mockImplementation(async (inkey, limit, offset) =>
    payments
      .filter(payment => `ink-${payment.wallet_id}` === inkey)
      .slice(offset, offset + limit),
  );
};

beforeEach(() => {
  jest.resetAllMocks();
  counter = 0;
  payments = [];
  mockListPeople.mockResolvedValue([alice, bob, carol]);
  usePaginated();
});

describe('zapHistoryService', () => {
  test('a zap is an outgoing Allowance payment with zap metadata', async () => {
    payments = [zap(alice, BOB, 21, 1000)];

    const zaps = await getRecentZaps();

    expect(zaps).toHaveLength(1);
    expect(zaps[0]).toMatchObject({ amountSats: 21, memo: 'thanks' });
    expect(zaps[0].from?.id).toBe(ALICE);
    expect(zaps[0].to?.id).toBe(BOB);
  });

  test('a recipient outside the directory is kept, with no recipient', async () => {
    payments = [zap(alice, 'dddddddd-0000-4000-8000-000000000004', 5, 1000)];

    const [only] = await getRecentZaps();

    expect(only.to).toBeNull();
    expect(only.from?.id).toBe(ALICE);
  });

  test('excludes sweeps, rewards, incoming and untagged payments', async () => {
    payments = [
      zap(alice, BOB, 1, 1000, { memo: 'Weekly Allowance cleared' }),
      zap(alice, BOB, 2, 1001, {
        extra: { ...zapExtra(alice, BOB), automation: true },
      }),
      zap(alice, BOB, 3, 1002, { amount: 3000 }),
      zap(alice, BOB, 4, 1003, { extra: {} }),
      // Not from an Allowance wallet Zaplie knows (the Fund, say).
      zap(alice, BOB, 5, 1004, { wallet_id: 'w-fund' }),
      zap(alice, BOB, 6, 1005),
    ];

    const zaps = await getRecentZaps();

    expect(zaps.map(z => z.amountSats)).toEqual([6]);
  });

  test('reads extra stored as a JSON string', async () => {
    payments = [
      zap(alice, BOB, 7, 1000, {
        extra: JSON.stringify(zapExtra(alice, BOB)) as unknown as Record<
          string,
          unknown
        >,
      }),
    ];

    expect((await getRecentZaps()).map(z => z.amountSats)).toEqual([7]);
  });

  test('deduplicates one payment that surfaces twice', async () => {
    const once = zap(alice, BOB, 8, 1000);
    payments = [once, { ...once, checking_id: `internal_${once.checking_id}` }];

    expect(await getRecentZaps()).toHaveLength(1);
  });

  test('filters by time and by person, sorts newest first and limits', async () => {
    payments = [
      zap(alice, BOB, 1, 100),
      zap(bob, ALICE, 2, 300),
      zap(alice, CAROL, 3, 200),
    ];

    expect(
      (await getRecentZaps({ sinceTimestamp: 150 })).map(z => z.amountSats),
    ).toEqual([2, 3]);
    expect(
      (await getRecentZaps({ userAadObjectId: CAROL.toUpperCase() })).map(
        z => z.amountSats,
      ),
    ).toEqual([3]);
    expect((await getRecentZaps({ limit: 2 })).map(z => z.amountSats)).toEqual([
      2, 3,
    ]);
  });

  test('returns nothing when the directory is empty', async () => {
    mockListPeople.mockResolvedValue([]);

    await expect(getRecentZaps()).resolves.toEqual([]);
    expect(mockGetAllPaymentsPage).not.toHaveBeenCalled();
  });
});

describe('getZapLeaderboard', () => {
  test('ranks sats sent, highest first, ties by name, self-zaps excluded', async () => {
    payments = [
      zap(alice, BOB, 10, 100),
      zap(alice, CAROL, 5, 101),
      zap(bob, ALICE, 15, 102),
      zap(alice, ALICE, 100, 103),
    ];

    const board = await getZapLeaderboard();

    expect(board.entries.map(e => [e.user.displayName, e.zappedSats])).toEqual([
      ['Alice', 15],
      ['Bob', 15],
    ]);
    expect(board.partial).toBe(false);
  });

  test('counts only zaps sent after sinceTimestamp', async () => {
    payments = [zap(alice, BOB, 10, 100), zap(alice, BOB, 4, 500)];

    const board = await getZapLeaderboard({ sinceTimestamp: 400 });

    expect(board.entries).toEqual([expect.objectContaining({ zappedSats: 4 })]);
  });
});

describe('payment paging', () => {
  test('pages the account-wide read until a short page comes back', async () => {
    payments = Array.from({ length: PAYMENTS_PAGE_SIZE + 1 }, (_, index) =>
      zap(alice, BOB, 1, index),
    );

    const activity = await getZapActivity({ limit: Number.MAX_SAFE_INTEGER });

    expect(activity.zaps).toHaveLength(PAYMENTS_PAGE_SIZE + 1);
    expect(mockGetAllPaymentsPage).toHaveBeenCalledTimes(2);
    expect(mockGetPayments).not.toHaveBeenCalled();
  });

  test('without the API token, pages each Allowance wallet by invoice key', async () => {
    useWalletFallback();
    payments = [zap(alice, BOB, 1, 100), zap(bob, ALICE, 2, 200)];

    const zaps = await getRecentZaps();

    expect(zaps.map(z => z.amountSats)).toEqual([2, 1]);
    expect(mockGetPayments.mock.calls.map(call => call[0]).sort()).toEqual([
      'ink-w-alice',
      'ink-w-bob',
    ]);
  });

  test('a non-availability error is not swallowed by the fallback', async () => {
    mockGetAllPaymentsPage.mockRejectedValue(new Error('LNbits is down'));

    await expect(getRecentZaps()).rejects.toThrow('LNbits is down');
  });
});

describe('incomplete reads are reported, never scored as zero', () => {
  test('a failed wallet read flags partial', async () => {
    useWalletFallback();
    payments = [zap(alice, BOB, 1, 100)];
    mockGetPayments.mockImplementation(async inkey => {
      if (inkey === 'ink-w-bob') throw new Error('429');
      return payments;
    });

    const activity = await getZapActivity();

    expect(activity.partial).toBe(true);
    expect(activity.skippedWallets).toBe(1);
    expect(activity.zaps).toHaveLength(1);
  });

  test('keeps in-flight wallet reads under the concurrency cap', async () => {
    useWalletFallback();
    const many = Array.from(
      { length: MAX_CONCURRENT_LNBITS_REQUESTS * 3 },
      (_, index) =>
        person(
          `eeeeeeee-0000-4000-8000-${String(index).padStart(12, '0')}`,
          `P${index}`,
          `w-${index}`,
        ),
    );
    mockListPeople.mockResolvedValue(many);
    let inFlight = 0;
    let peak = 0;
    mockGetPayments.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 2));
      inFlight -= 1;
      return [];
    });

    await getZapActivity();

    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_LNBITS_REQUESTS);
    expect(mockGetPayments).toHaveBeenCalledTimes(many.length);
  });
});
