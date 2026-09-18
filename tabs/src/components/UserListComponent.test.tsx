import React, { act, useEffect } from 'react';
import { createRoot, Root } from 'react-dom/client';
import UserListComponent from './UserListComponent';
import { RewardNameContext } from './RewardNameContext';
import { CacheProvider, useCache } from '../utils/CacheContext';
import { getUsers, getUserWallets } from '../services/lnbitsServiceLocal';

jest.mock('../services/lnbitsServiceLocal', () => ({
  getUsers: jest.fn(),
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
            value={{ rewardName: 'sats', setRewardName: jest.fn() }}
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

  test('reuses users from the shared cache without loading the directory again', async () => {
    mockGetUserWallets.mockResolvedValue([]);

    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <CacheProvider>
          <RewardNameContext.Provider
            value={{ rewardName: 'sats', setRewardName: jest.fn() }}
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
            value={{ rewardName: 'sats', setRewardName: jest.fn() }}
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
