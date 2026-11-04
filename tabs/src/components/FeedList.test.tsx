import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  getAllPayments,
  getWalletTransactionsSince,
} from '../services/lnbits/payments';
import { getUsers } from '../services/lnbits/users';
import { getUserWallets } from '../services/lnbits/wallets';
import { PAYMENT_PAGE_SIZE } from '../utils/walletUtilities';
import FeedList from './FeedList';

// The service layer is mocked, not walletUtilities, so the real pairing rule
// decides what the feed shows.
jest.mock('../services/lnbits/payments', () => ({
  getAllPayments: jest.fn(),
  getWalletTransactionsSince: jest.fn(),
}));

jest.mock('../services/lnbits/users', () => ({
  getUsers: jest.fn(),
}));

jest.mock('../services/lnbits/wallets', () => ({
  getUserWallets: jest.fn(),
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
const walletsByUser: Record<string, Wallet[]> = {
  [alex.id]: [
    wallet('alex-a', 'Allowance', alex.id),
    wallet('alex-p', 'Private', alex.id),
  ],
  [sam.id]: [
    wallet('sam-a', 'Allowance', sam.id),
    wallet('sam-p', 'Private', sam.id),
  ],
};

// Alex zaps Sam 20,000 sats; Sam moves 5,000 sats from his own Allowance into
// his own Private wallet, which is not a zap.
const payments = [
  payment('internal_gift', 'alex-a', -20_000_000, 'Thanks'),
  payment('gift', 'sam-p', 20_000_000, 'Thanks'),
  payment('internal_self', 'sam-a', -5_000_000, 'Mine'),
  payment('self', 'sam-p', 5_000_000, 'Mine'),
];

let container: HTMLDivElement;
let root: Root;

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

const mount = async () => {
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => {
    root.render(<FeedList timestamp={0} />);
  });
};

describe('FeedList', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    (getUsers as jest.Mock).mockResolvedValue([alex, sam]);
    (getUserWallets as jest.Mock).mockImplementation(async (userId: string) =>
      Promise.resolve(walletsByUser[userId] ?? []),
    );
    // One short page: the whole history.
    (getAllPayments as jest.Mock).mockResolvedValue(payments);
    (getWalletTransactionsSince as jest.Mock).mockImplementation(
      async (walletId: string) =>
        Promise.resolve(payments.filter(row => row.wallet_id === walletId)),
    );
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

  test('leaves a self-zap out of the feed', async () => {
    await mount();
    await eventually(() => {
      expect(container.textContent).toContain('Thanks');
    });

    expect(container.textContent).toContain('Alex Rivera');
    expect(container.textContent).toContain('Sam Chen');
    expect(container.textContent).not.toContain('Mine');
    expect(container.querySelectorAll('[data-testid="feed-row"]')).toHaveLength(
      1,
    );
    expect(container.textContent).toContain('20,000');
  });

  test('reads the team feed through fetchZapActivity', async () => {
    await mount();
    await eventually(() => {
      expect(container.textContent).toContain('Thanks');
    });

    expect(getAllPayments).toHaveBeenCalledWith(PAYMENT_PAGE_SIZE, 0);
    expect(getWalletTransactionsSince).not.toHaveBeenCalled();
  });

  test('says so when the history was truncated', async () => {
    // Every page is full, so paging runs into PAYMENT_FETCH_CAP.
    const fullPage = [
      ...payments,
      ...Array.from({ length: PAYMENT_PAGE_SIZE - payments.length }, (_, i) =>
        payment(`external-${i}`, 'alex-p', 1_000, 'Invoice'),
      ),
    ];
    (getAllPayments as jest.Mock).mockResolvedValue(fullPage);

    await mount();
    await eventually(() => {
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        'History truncated',
      );
    });
    expect(container.textContent).toContain('Thanks');
  });
});
