// zapHistoryService.test.ts
//
// Mocks the portal boundary (peopleDirectory), not zapHistoryService. A zap
// is Zaplie's own record of a payment it made between two directory members;
// automation rewards are recorded too and never counted as zaps.

import {
  getRecentZaps,
  getZapActivity,
  getZapLeaderboard,
} from './zapHistoryService';
import { listPeople, listZaps, ZapRecord } from './peopleDirectory';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('./peopleDirectory');

const mockListPeople = listPeople as jest.MockedFunction<typeof listPeople>;
const mockListZaps = listZaps as jest.MockedFunction<typeof listZaps>;

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const CAROL = 'cccccccc-0000-4000-8000-000000000003';

const person = (oid: string, displayName: string): User => ({
  id: oid,
  displayName,
  profileImg: '',
  aadObjectId: oid,
  email: '',
  allowanceWallet: { id: `w-${displayName}` },
  canReceive: true,
});

let records: ZapRecord[] = [];
let counter = 0;
const zap = (
  from: string,
  to: string,
  sats: number,
  time: number,
  kind: 'zap' | 'reward' = 'zap',
): ZapRecord => ({
  paymentHash: `hash-${(counter += 1)}`,
  kind,
  time,
  amountSats: sats,
  memo: 'thanks',
  from: { oid: from, displayName: from },
  to: { oid: to, displayName: to },
});

beforeEach(() => {
  jest.resetAllMocks();
  counter = 0;
  records = [];
  mockListPeople.mockResolvedValue([
    person(ALICE, 'Alice'),
    person(BOB, 'Bob'),
    person(CAROL, 'Carol'),
  ]);
  mockListZaps.mockImplementation(async since =>
    records.filter(record => !since || record.time >= since),
  );
});

describe('zapHistoryService', () => {
  test('a zap names both directory people', async () => {
    records = [zap(ALICE, BOB, 21, 1000)];

    const [only] = await getRecentZaps();

    expect(only).toMatchObject({ amountSats: 21, memo: 'thanks' });
    expect(only.from?.displayName).toBe('Alice');
    expect(only.to?.displayName).toBe('Bob');
    expect(only.time).toEqual(new Date(1000 * 1000));
  });

  test('rewards are not zaps, and someone who left the directory has no user', async () => {
    records = [
      zap(ALICE, BOB, 5, 1000, 'reward'),
      zap('dddddddd-0000-4000-8000-000000000004', BOB, 3, 900),
    ];

    const zaps = await getRecentZaps();

    expect(zaps).toHaveLength(1);
    expect(zaps[0].from).toBeNull();
    expect(zaps[0].to?.displayName).toBe('Bob');
  });

  test('filters by time and by person, sorts newest first and limits', async () => {
    records = [
      zap(ALICE, BOB, 1, 100),
      zap(BOB, ALICE, 2, 300),
      zap(ALICE, CAROL, 3, 200),
    ];

    expect(
      (await getRecentZaps({ sinceTimestamp: 150 })).map(z => z.amountSats),
    ).toEqual([2, 3]);
    expect(mockListZaps).toHaveBeenLastCalledWith(150);
    expect(
      (await getRecentZaps({ userAadObjectId: CAROL.toUpperCase() })).map(
        z => z.amountSats,
      ),
    ).toEqual([3]);
    expect((await getRecentZaps({ limit: 2 })).map(z => z.amountSats)).toEqual([
      2, 3,
    ]);
  });

  test('one read of the records is complete, never partial', async () => {
    records = [zap(ALICE, BOB, 1, 100)];

    await expect(getZapActivity()).resolves.toMatchObject({
      partial: false,
      skippedUsers: 0,
      skippedWallets: 0,
      truncated: false,
    });
  });

  test('a portal failure is an error, not an empty history', async () => {
    mockListZaps.mockRejectedValue(new Error('listZaps failed (status: 502)'));

    await expect(getRecentZaps()).rejects.toThrow('502');
  });
});

describe('getZapLeaderboard', () => {
  test('ranks sats sent, highest first, ties by name, self-zaps excluded', async () => {
    records = [
      zap(ALICE, BOB, 10, 100),
      zap(ALICE, CAROL, 5, 101),
      zap(BOB, ALICE, 15, 102),
      zap(ALICE, ALICE, 100, 103),
    ];

    const board = await getZapLeaderboard();

    expect(board.entries.map(e => [e.user.displayName, e.zappedSats])).toEqual([
      ['Alice', 15],
      ['Bob', 15],
    ]);
  });

  test('counts only zaps sent after sinceTimestamp', async () => {
    records = [zap(ALICE, BOB, 10, 100), zap(ALICE, BOB, 4, 500)];

    const board = await getZapLeaderboard({ sinceTimestamp: 400 });

    expect(board.entries).toEqual([expect.objectContaining({ zappedSats: 4 })]);
  });
});
