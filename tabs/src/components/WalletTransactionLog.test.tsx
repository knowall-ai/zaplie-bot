import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  getUsers,
  getUserWallets,
  getWalletTransactionsSince,
} from '../services/lnbitsServiceLocal';
import { fetchZapActivity } from '../utils/walletUtilities';
import { RewardNameContext } from './RewardNameContext';
import WalletTransactionLog from './WalletTransactionLog';

const mockUseMsal = jest.fn();

jest.mock('@azure/msal-react', () => ({
  useMsal: () => mockUseMsal(),
}));

jest.mock('../services/lnbitsServiceLocal', () => ({
  getUsers: jest.fn(),
  getUserWallets: jest.fn(),
  getWalletTransactionsSince: jest.fn(),
}));

jest.mock('../utils/walletUtilities', () => ({
  ...jest.requireActual('../utils/walletUtilities'),
  fetchZapActivity: jest.fn(),
}));

const user = (id: string, displayName: string): User => ({
  id,
  displayName,
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
  memo: string,
  time = 1_700_000_000,
): Transaction => ({
  checking_id: checkingId,
  pending: false,
  amount,
  fee: 0,
  memo,
  time,
  extra: { tag: 'zap' },
  wallet_id: walletId,
});

const alex = user('alex', 'Alex Rivera');
const sam = user('sam', 'Sam Chen');
const privateWallet = wallet('alex-private', 'Private', alex.id);
const privateArchive = wallet(
  'alex-private-archive',
  'Private archive',
  alex.id,
);
const knownIncoming = payment(
  'known-transfer',
  privateWallet.id,
  20_000,
  'Thanks for the review',
);
const knownOutgoingPair = payment(
  'internal_known-transfer',
  'sam-allowance',
  -20_000,
  'Thanks for the review',
);

let container: HTMLDivElement;
let root: Root;

const mount = async (
  activeTab: 'all' | 'sent' | 'received' = 'all',
  rewardContext: React.ContextType<typeof RewardNameContext> = {
    rewardName: 'Sats',
    setRewardName: jest.fn(),
    isLoading: false,
    error: null,
  },
) => {
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => {
    root.render(
      <RewardNameContext.Provider value={rewardContext}>
        <WalletTransactionLog activeTab={activeTab} activeWallet="Private" />
      </RewardNameContext.Provider>,
    );
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

const configureSuccess = (transactions: Transaction[] = [knownIncoming]) => {
  (getUsers as jest.Mock).mockResolvedValue([alex]);
  (getUserWallets as jest.Mock).mockResolvedValue([
    privateArchive,
    privateWallet,
  ]);
  (getWalletTransactionsSince as jest.Mock).mockResolvedValue(transactions);
  (fetchZapActivity as jest.Mock).mockResolvedValue({
    users: [alex, sam],
    transfers: [{ transaction: knownOutgoingPair, from: sam, to: alex }],
  });
};

describe('WalletTransactionLog', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_100_000);
    mockUseMsal.mockReturnValue({ accounts: [{ localAccountId: 'aad-alex' }] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    jest.restoreAllMocks();
  });

  test('uses the exact selected wallet and verified transfer pairing', async () => {
    configureSuccess();

    await mount();
    await eventually(() => {
      expect(container.textContent).toContain('from Sam Chen');
    });

    expect(getUsers).toHaveBeenCalledWith({ aadObjectId: 'aad-alex' });
    expect(getWalletTransactionsSince).toHaveBeenCalledWith(
      privateWallet.id,
      expect.any(Number),
      null,
    );
    expect(container.textContent).toContain('+20 Sats');
    expect(container.textContent).not.toContain('$0.11');
  });

  test('rejects ambiguous selected wallets', async () => {
    configureSuccess();
    (getUserWallets as jest.Mock).mockResolvedValue([
      privateWallet,
      wallet('alex-private-copy', ' private ', alex.id),
    ]);

    await mount();
    await eventually(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Your Private wallet could not be identified uniquely.',
      );
    });

    expect(getWalletTransactionsSince).not.toHaveBeenCalled();
    expect(fetchZapActivity).not.toHaveBeenCalled();
  });

  test('does not infer a counterparty from memo text or mutate API data', async () => {
    const unpaired = payment(
      'external-payment',
      privateWallet.id,
      4_000,
      'Payment from Sam Chen',
    );
    const originalExtra = unpaired.extra;
    configureSuccess([unpaired]);
    (fetchZapActivity as jest.Mock).mockResolvedValue({
      users: [alex, sam],
      transfers: [],
    });

    await mount();
    await eventually(() => {
      expect(container.textContent).toContain('Counterparty unavailable');
    });

    expect(container.textContent).toContain('from Counterparty unavailable');
    expect(unpaired.extra).toBe(originalExtra);
    expect(unpaired.extra).toEqual({ tag: 'zap' });
  });

  test('fails closed on incomplete activity data and retries the full request', async () => {
    configureSuccess();
    (fetchZapActivity as jest.Mock)
      .mockRejectedValueOnce(new Error('Transaction history is unavailable.'))
      .mockResolvedValueOnce({
        users: [alex, sam],
        transfers: [{ transaction: knownOutgoingPair, from: sam, to: alex }],
      });

    await mount();
    await eventually(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Transaction history is unavailable.',
      );
    });
    expect(container.textContent).not.toContain('+20 Sats');

    const retry = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent === 'Try again',
    );
    if (!retry) throw new Error('Retry button was not rendered.');
    await act(async () => {
      retry.click();
    });
    await eventually(() => {
      expect(container.textContent).toContain('from Sam Chen');
    });
    expect(fetchZapActivity).toHaveBeenCalledTimes(2);
  });

  test('does not query wallet data without an authenticated account', async () => {
    mockUseMsal.mockReturnValue({ accounts: [] });

    await mount();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Sign in to load your transaction history.',
    );
    expect(getUsers).not.toHaveBeenCalled();
    expect(getUserWallets).not.toHaveBeenCalled();
    expect(fetchZapActivity).not.toHaveBeenCalled();
  });

  test('does not select an arbitrary MSAL account', async () => {
    mockUseMsal.mockReturnValue({
      accounts: [{ localAccountId: 'aad-alex' }, { localAccountId: 'aad-sam' }],
    });

    await mount();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Your Zaplie account could not be identified.',
    );
    expect(getUsers).not.toHaveBeenCalled();
    expect(getUserWallets).not.toHaveBeenCalled();
  });

  test('does not invent a reward name when configuration is unavailable', async () => {
    configureSuccess();

    await mount('all', {
      rewardName: null,
      setRewardName: jest.fn(),
      isLoading: false,
      error: new Error('Reward configuration is unavailable.'),
      retry: jest.fn(),
    });
    await eventually(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Reward configuration is unavailable.',
      );
    });

    expect(container.textContent).not.toContain('sats');
  });
});
