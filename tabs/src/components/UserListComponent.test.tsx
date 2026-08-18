import React, { act, useEffect, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import UserListComponent, {
  WALLET_FETCH_CONCURRENCY,
} from './UserListComponent';
import { RewardNameContext } from './RewardNameContext';
import { CacheProvider, useCache } from '../utils/CacheContext';
import { getUsers } from '../services/lnbits/users';
import { getUserWallets } from '../services/lnbits/wallets';

jest.mock('../services/lnbits/users', () => ({
  getUsers: jest.fn(),
}));

jest.mock('../services/lnbits/wallets', () => ({
  getUserWallets: jest.fn(),
}));

const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;
const mockGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const user: User = {
  id: 'user-1',
  displayName: 'Ada Lovelace',
  profileImg: '',
  aadObjectId: 'aad-1',
  email: 'ada@example.com',
  type: 'Teammate',
  privateWallet: null,
  allowanceWallet: null,
};

// Seeds the shared cache exactly once, so a component that refills the cache
// does not fight the wrapper for it.
const UserListWithSeededCache = ({ seed }: { seed: User[] }) => {
  const { setCache } = useCache();
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    setCache('allUsers', seed);
    setSeeded(true);
    // Seed once: later cache writes come from UserListComponent itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return seeded ? <UserListComponent /> : null;
};

const UserListWithCachedUsers = ({ users }: { users: User[] }) => {
  const { cache, setCache } = useCache();

  useEffect(() => {
    if (cache['allUsers'] !== users) {
      setCache('allUsers', users);
    }
  }, [cache, setCache, users]);

  return cache['allUsers'] === users ? <UserListComponent /> : null;
};

describe('UserListComponent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('loads users when the shared cache is empty', async () => {
    mockGetUsers.mockResolvedValue([user]);
    mockGetUserWallets.mockResolvedValue([
      {
        id: 'private-1',
        name: 'Private',
        user: user.id,
        balance_msat: 42000,
        deleted: false,
      },
      {
        id: 'allowance-1',
        name: 'Allowance',
        user: user.id,
        balance_msat: 21000,
        deleted: false,
      },
    ]);

    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <CacheProvider>
          <RewardNameContext.Provider
            value={{
              rewardName: 'sats',
              rewardNameLabel: 'sats',
              setRewardName: jest.fn(),
            }}
          >
            <UserListComponent />
          </RewardNameContext.Provider>
        </CacheProvider>,
      );
    });

    expect(container.textContent).toContain('Ada Lovelace');
    expect(container.textContent).toContain('42 sats');
    expect(container.textContent).toContain('21 sats');
    expect(mockGetUsers).toHaveBeenCalledTimes(1);
    expect(mockGetUserWallets).toHaveBeenCalledWith(user.id);
  });

  test('renders the error state when the directory request fails', async () => {
    mockGetUsers.mockRejectedValue(new Error('LNbits directory unavailable'));
    mockGetUserWallets.mockResolvedValue([]);

    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <CacheProvider>
          <RewardNameContext.Provider
            value={{
              rewardName: 'sats',
              rewardNameLabel: 'sats',
              setRewardName: jest.fn(),
            }}
          >
            <UserListComponent />
          </RewardNameContext.Provider>
        </CacheProvider>,
      );
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('LNbits directory unavailable');
    expect(container.textContent).not.toContain('null');
    expect(container.textContent).not.toContain('Loading...');
    expect(container.querySelector('[role="table"]')).toBeNull();
    expect(mockGetUserWallets).not.toHaveBeenCalled();

    // The error state is retryable rather than terminal.
    mockGetUsers.mockResolvedValue([user]);
    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      alert?.querySelector('button')?.click();
    });
    expect(mockGetUsers).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="table"]')).not.toBeNull();
    expect(container.textContent).toContain('Ada Lovelace');
  });

  test('loads wallets a bounded number of requests at a time', async () => {
    const manyUsers = Array.from({ length: 12 }, (_, index) => ({
      ...user,
      id: `user-${index}`,
      displayName: `User ${index}`,
    }));
    mockGetUsers.mockResolvedValue(manyUsers);

    let inFlight = 0;
    let peakInFlight = 0;
    mockGetUserWallets.mockImplementation(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return [];
    });

    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <CacheProvider>
          <RewardNameContext.Provider
            value={{
              rewardName: 'sats',
              rewardNameLabel: 'sats',
              setRewardName: jest.fn(),
            }}
          >
            <UserListComponent />
          </RewardNameContext.Provider>
        </CacheProvider>,
      );
    });

    expect(mockGetUserWallets).toHaveBeenCalledTimes(12);
    expect(peakInFlight).toBeLessThanOrEqual(WALLET_FETCH_CONCURRENCY);
    expect(container.textContent).toContain('User 11');
  });

  test('treats an empty cached directory as a cold cache', async () => {
    mockGetUsers.mockResolvedValue([user]);
    mockGetUserWallets.mockResolvedValue([]);

    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <CacheProvider>
          <RewardNameContext.Provider
            value={{
              rewardName: 'sats',
              rewardNameLabel: 'sats',
              setRewardName: jest.fn(),
            }}
          >
            <UserListWithSeededCache seed={[]} />
          </RewardNameContext.Provider>
        </CacheProvider>,
      );
    });

    expect(mockGetUsers).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Ada Lovelace');
  });

  test('reuses users from the shared cache without loading the directory again', async () => {
    mockGetUserWallets.mockResolvedValue([]);

    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <CacheProvider>
          <RewardNameContext.Provider
            value={{
              rewardName: 'sats',
              rewardNameLabel: 'sats',
              setRewardName: jest.fn(),
            }}
          >
            <UserListWithCachedUsers users={[user]} />
          </RewardNameContext.Provider>
        </CacheProvider>,
      );
    });

    expect(container.textContent).toContain('Ada Lovelace');
    expect(mockGetUsers).not.toHaveBeenCalled();
    expect(mockGetUserWallets).toHaveBeenCalledWith(user.id);
  });

  test('refuses wallets that are not an exact, owned match', async () => {
    mockGetUsers.mockResolvedValue([user]);
    mockGetUserWallets.mockResolvedValue([
      // Substring match on an unrelated wallet.
      {
        id: 'private-archive',
        name: 'Private archive',
        user: user.id,
        balance_msat: 999_000,
        deleted: false,
      },
      // Exact name, but owned by somebody else.
      {
        id: 'allowance-other',
        name: 'Allowance',
        user: 'user-2',
        balance_msat: 888_000,
        deleted: false,
      },
    ]);

    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <CacheProvider>
          <RewardNameContext.Provider
            value={{
              rewardName: 'sats',
              rewardNameLabel: 'sats',
              setRewardName: jest.fn(),
            }}
          >
            <UserListComponent />
          </RewardNameContext.Provider>
        </CacheProvider>,
      );
    });

    expect(container.textContent).toContain('Ada Lovelace');
    expect(container.textContent).not.toContain('999');
    expect(container.textContent).not.toContain('888');
    expect(container.textContent).toContain('Unavailable');
  });

  test('renders an explicit empty state when the directory is empty', async () => {
    mockGetUsers.mockResolvedValue([]);
    mockGetUserWallets.mockResolvedValue([]);

    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <CacheProvider>
          <RewardNameContext.Provider
            value={{
              rewardName: 'sats',
              rewardNameLabel: 'sats',
              setRewardName: jest.fn(),
            }}
          >
            <UserListComponent />
          </RewardNameContext.Provider>
        </CacheProvider>,
      );
    });

    const empty = container.querySelector('[role="status"]');
    expect(empty?.textContent).toContain('No users found.');
    // role="status" is not a valid child of a table, so the message lives
    // outside it.
    expect(
      container.querySelector('[role="table"] [role="status"]'),
    ).toBeNull();
  });

  test('hides service accounts without a linked Entra identity', async () => {
    const serviceAccount: User = {
      ...user,
      id: 'svc-1',
      displayName: 'zaplietestsvc',
      aadObjectId: '',
    };
    mockGetUsers.mockResolvedValue([user, serviceAccount]);
    mockGetUserWallets.mockResolvedValue([]);

    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <CacheProvider>
          <RewardNameContext.Provider
            value={{
              rewardName: 'sats',
              rewardNameLabel: 'sats',
              setRewardName: jest.fn(),
            }}
          >
            <UserListComponent />
          </RewardNameContext.Provider>
        </CacheProvider>,
      );
    });

    expect(container.textContent).toContain('Ada Lovelace');
    expect(container.textContent).not.toContain('zaplietestsvc');
    expect(mockGetUserWallets).not.toHaveBeenCalledWith(serviceAccount.id);
  });
});
