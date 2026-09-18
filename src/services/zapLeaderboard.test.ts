// zapLeaderboard.test.ts
//
// Pure aggregation and settings. The LNbits boundary is covered by the
// zapHistoryService and showLeaderboardCommand suites.

import { describe, expect, test } from '@jest/globals';
import { ZapActivity } from './zapHistoryService';
import {
  DEFAULT_LEADERBOARD_TOP_N,
  DEFAULT_LEADERBOARD_WINDOW_DAYS,
  leaderboardEmptyMessage,
  leaderboardTitle,
  rankZapSenders,
  readLeaderboardSettings,
  windowStartSeconds,
} from './zapLeaderboard';

const person = (id: string, displayName: string): User => ({
  id,
  displayName,
  profileImg: '',
  aadObjectId: `aad-${id}`,
  email: `${id}@example.test`,
  privateWallet: null,
  allowanceWallet: null,
});

const alice = person('alice', 'Alice');
const bob = person('bob', 'Bob');
const carol = person('carol', 'Carol');

const zap = (
  from: User | null,
  amountSats: number,
  to: User | null = null,
): ZapActivity => ({
  from,
  to,
  amountSats,
  memo: 'Nice!',
  time: new Date('2026-09-01T00:00:00Z'),
});

describe('rankZapSenders', () => {
  test('sums sats per sender and ranks the highest first', () => {
    const ranked = rankZapSenders(
      [zap(alice, 100, bob), zap(bob, 300, alice), zap(alice, 150, carol)],
      10,
    );

    expect(ranked).toEqual([
      { displayName: 'Bob', zapsSent: 1, satsSent: 300 },
      { displayName: 'Alice', zapsSent: 2, satsSent: 250 },
    ]);
  });

  test('breaks ties by display name so the card is stable', () => {
    const ranked = rankZapSenders(
      [zap(carol, 100), zap(alice, 100), zap(bob, 100)],
      10,
    );

    expect(ranked.map(entry => entry.displayName)).toEqual([
      'Alice',
      'Bob',
      'Carol',
    ]);
  });

  test('caps the result at topN', () => {
    const ranked = rankZapSenders(
      [zap(alice, 300), zap(bob, 200), zap(carol, 100)],
      2,
    );

    expect(ranked.map(entry => entry.displayName)).toEqual(['Alice', 'Bob']);
  });

  test('skips zaps whose sender could not be resolved', () => {
    const ranked = rankZapSenders([zap(null, 900), zap(alice, 10)], 10);

    expect(ranked).toEqual([
      { displayName: 'Alice', zapsSent: 1, satsSent: 10 },
    ]);
  });

  test('skips self-zaps because paying yourself is not recognition', () => {
    const ranked = rankZapSenders(
      [zap(alice, 900, alice), zap(bob, 10, alice)],
      10,
    );

    expect(ranked).toEqual([{ displayName: 'Bob', zapsSent: 1, satsSent: 10 }]);
  });

  test('keeps a zero-sat sender at the bottom instead of dropping them', () => {
    const ranked = rankZapSenders([zap(alice, 0), zap(bob, 5)], 10);

    expect(ranked.map(entry => entry.displayName)).toEqual(['Bob', 'Alice']);
  });

  test('returns nothing when there are no zaps', () => {
    expect(rankZapSenders([], 10)).toEqual([]);
  });
});

describe('readLeaderboardSettings', () => {
  test('defaults to the same window as the portal and ten rows', () => {
    expect(readLeaderboardSettings({})).toEqual({
      windowDays: DEFAULT_LEADERBOARD_WINDOW_DAYS,
      topN: DEFAULT_LEADERBOARD_TOP_N,
    });
    expect(DEFAULT_LEADERBOARD_WINDOW_DAYS).toBe(7);
    expect(DEFAULT_LEADERBOARD_TOP_N).toBe(10);
  });

  test('reads explicit whole-number values', () => {
    expect(
      readLeaderboardSettings({
        LEADERBOARD_WINDOW_DAYS: '30',
        LEADERBOARD_TOP_N: ' 3 ',
      }),
    ).toEqual({ windowDays: 30, topN: 3 });
  });

  test('treats blank values as unset', () => {
    expect(
      readLeaderboardSettings({
        LEADERBOARD_WINDOW_DAYS: '  ',
        LEADERBOARD_TOP_N: '',
      }),
    ).toEqual({ windowDays: 7, topN: 10 });
  });

  test.each(['0', '-1', '1.5', 'abc', '1e2', '0x10', '+5', '10.0'])(
    'rejects LEADERBOARD_TOP_N=%s naming the variable',
    raw => {
      expect(() => readLeaderboardSettings({ LEADERBOARD_TOP_N: raw })).toThrow(
        /LEADERBOARD_TOP_N must be a whole number of at least 1/,
      );
    },
  );

  test.each(['0', '-7', '2.5', 'week', '1e2'])(
    'rejects LEADERBOARD_WINDOW_DAYS=%s naming the variable',
    raw => {
      expect(() =>
        readLeaderboardSettings({ LEADERBOARD_WINDOW_DAYS: raw }),
      ).toThrow(/LEADERBOARD_WINDOW_DAYS must be a whole number of at least 1/);
    },
  );
});

describe('window helpers', () => {
  test('windowStartSeconds counts back whole days from now', () => {
    const nowMs = 1_760_000_000_000;

    expect(windowStartSeconds(30, nowMs)).toBe(1_760_000_000 - 30 * 86_400);
    expect(windowStartSeconds(7, nowMs)).toBe(1_760_000_000 - 7 * 86_400);
  });

  test('title and empty message name the window and the label, never a balance', () => {
    expect(leaderboardTitle(7, 'Sats')).toBe(
      'Top zappers (Sats sent, last 7 days):',
    );
    expect(leaderboardTitle(30, 'Points')).toBe(
      'Top zappers (Points sent, last 30 days):',
    );
    expect(leaderboardEmptyMessage(7)).toBe(
      'No zaps sent in the last 7 days yet. Send a zap to get things started!',
    );
    for (const text of [
      leaderboardTitle(7, 'Sats'),
      leaderboardEmptyMessage(7),
    ]) {
      expect(text).not.toMatch(/balance|private/i);
    }
  });
});
