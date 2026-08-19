import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import WalletYourWalletInfoCard from './WalletInfoCard';
import { RewardNameContext } from './RewardNameContext';

const mockUseMsal = jest.fn();
const mockGetUsers = jest.fn<Promise<User[]>, [{ aadObjectId: string }]>();
const mockGetUserWallets = jest.fn<Promise<Wallet[]>, [string]>();

jest.mock('@azure/msal-react', () => ({
  useMsal: () => mockUseMsal(),
}));

jest.mock('../services/lnbitsServiceLocal', () => ({
  getUsers: (filter: { aadObjectId: string }) => mockGetUsers(filter),
  getUserWallets: (userId: string) => mockGetUserWallets(userId),
}));

jest.mock('./ReceivePayment', () => ({
  __esModule: true,
  default: ({ currentUserLNbitDetails }: { currentUserLNbitDetails: User }) => (
    <div data-testid="receive-user">
      {currentUserLNbitDetails.privateWallet?.id}
    </div>
  ),
}));

jest.mock('./SendPayment', () => ({
  __esModule: true,
  default: ({ currentUserLNbitDetails }: { currentUserLNbitDetails: User }) => (
    <div data-testid="send-user">
      {currentUserLNbitDetails.privateWallet?.id}
    </div>
  ),
}));

const user: User = {
  id: 'user-1',
  displayName: 'Alex Rivera',
  profileImg: '',
  aadObjectId: 'aad-1',
  email: 'alex@example.test',
  type: 'Teammate',
  privateWallet: null,
  allowanceWallet: null,
};

const exactPrivateWallet: Wallet = {
  id: 'private-1',
  name: 'Private',
  user: user.id,
  balance_msat: 20_000,
  deleted: false,
};

const similarlyNamedWallet: Wallet = {
  id: 'private-archive',
  name: 'Private archive',
  user: user.id,
  balance_msat: 999_000,
  deleted: false,
};

let container: HTMLDivElement;
let root: Root;

const mountWallet = () => {
  root.render(
    <RewardNameContext.Provider
      value={{ rewardName: 'Sats', setRewardName: jest.fn() }}
    >
      <WalletYourWalletInfoCard />
    </RewardNameContext.Provider>,
  );
};

const renderWallet = async () => {
  await act(async () => {
    mountWallet();
  });
};

const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const eventually = async (assertion: () => void) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
};

const getButton = (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Button "${label}" was not rendered.`);
  return button;
};

describe('WalletInfoCard', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    mockUseMsal.mockReturnValue({
      accounts: [{ localAccountId: 'aad-1' }],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test('shows loading without a fake zero and disables wallet actions', async () => {
    mockGetUsers.mockReturnValue(new Promise(() => undefined));

    await renderWallet();

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Loading wallet...',
    );
    expect(container.querySelector('h1')).toBeNull();
    expect(getButton('Receive').disabled).toBe(true);
    expect(getButton('Send').disabled).toBe(true);
  });

  test('uses the authenticated user and the exact Private wallet', async () => {
    mockGetUsers.mockResolvedValue([user]);
    mockGetUserWallets.mockResolvedValue([
      similarlyNamedWallet,
      exactPrivateWallet,
    ]);

    await renderWallet();
    await eventually(() => {
      expect(container.querySelector('h1')?.textContent).toBe('20');
    });

    expect(mockGetUsers).toHaveBeenCalledWith({ aadObjectId: 'aad-1' });
    expect(mockGetUserWallets).toHaveBeenCalledWith('user-1');
    expect(getButton('Receive').disabled).toBe(false);
    expect(getButton('Send').disabled).toBe(false);

    await act(async () => {
      getButton('Receive').click();
    });
    expect(
      container.querySelector('[data-testid="receive-user"]')?.textContent,
    ).toBe('private-1');
  });

  test('shows an error and retries when the exact Private wallet is missing', async () => {
    mockGetUsers.mockResolvedValue([user]);
    mockGetUserWallets
      .mockResolvedValueOnce([similarlyNamedWallet])
      .mockResolvedValueOnce([exactPrivateWallet]);

    await renderWallet();
    await eventually(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "We couldn't find your Private wallet.",
      );
    });
    expect(container.querySelector('h1')).toBeNull();
    expect(getButton('Receive').disabled).toBe(true);

    await act(async () => {
      getButton('Try again').click();
    });
    await eventually(() => {
      expect(container.querySelector('h1')?.textContent).toBe('20');
    });
    expect(mockGetUserWallets).toHaveBeenCalledTimes(2);
  });

  test('refuses a Private wallet owned by another user', async () => {
    mockGetUsers.mockResolvedValue([user]);
    mockGetUserWallets.mockResolvedValue([
      { ...exactPrivateWallet, user: 'user-2' },
    ]);

    await renderWallet();
    await eventually(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "We couldn't confirm your Private wallet belongs to you.",
      );
    });
    expect(container.querySelector('h1')).toBeNull();
    expect(getButton('Send').disabled).toBe(true);
  });

  test('does not query wallets without an authenticated account', async () => {
    mockUseMsal.mockReturnValue({ accounts: [] });

    await renderWallet();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Sign in to load your wallet.',
    );
    expect(mockGetUsers).not.toHaveBeenCalled();
    expect(mockGetUserWallets).not.toHaveBeenCalled();
  });
});
