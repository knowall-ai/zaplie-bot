import React, { act } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { createRoot, Root } from 'react-dom/client';
import {
  fetchZapActivity,
  ZapActivity,
  zapActivityQueryOptions,
} from '../utils/walletUtilities';
import FeedList from './FeedList';

jest.mock('../utils/walletUtilities', () => {
  const actual = jest.requireActual('../utils/walletUtilities');
  return {
    ...actual,
    fetchZapActivity: jest.fn(),
    zapActivityQueryOptions: (periodDays?: number) => {
      const options = actual.zapActivityQueryOptions(periodDays);
      return {
        ...options,
        queryFn: () =>
          jest
            .requireMock('../utils/walletUtilities')
            .fetchZapActivity(options.queryKey[2]),
      };
    },
  };
});

const sender = (id: string): User => ({
  id,
  displayName: `Sender ${id}`,
  profileImg: '',
  aadObjectId: `aad-${id}`,
  email: `${id}@example.test`,
  type: 'Teammate',
  privateWallet: null,
  allowanceWallet: null,
});

const recipient = (id: string): User => ({
  ...sender(id),
  displayName: `Recipient ${id}`,
});

const ActivityQueryObserver: React.FC = () => {
  useQuery(zapActivityQueryOptions());
  return null;
};

const activityWithZaps = (count: number): ZapActivity => {
  const time = Math.floor(Date.now() / 1000);
  return {
    users: [],
    truncated: false,
    transfers: Array.from({ length: count }, (_unused, index) => {
      const id = String(index + 1);
      return {
        from: sender(id),
        to: recipient(id),
        transaction: {
          checking_id: `zap-${id}`,
          pending: false,
          amount: -5_000,
          fee: 0,
          memo: `Zap ${id}`,
          time,
          extra: { tag: 'zap' },
          wallet_id: `wallet-${id}`,
        },
      };
    }),
  };
};

describe('FeedList', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  const mount = async (timestamp = 0) => {
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActivityQueryObserver />
          <FeedList timestamp={timestamp} />
        </QueryClientProvider>,
      );
    });
  };

  const settle = async () => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_100_000);
    (fetchZapActivity as jest.Mock).mockResolvedValue(activityWithZaps(101));
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    jest.restoreAllMocks();
  });

  test('shows all fetched records through the existing UI pagination', async () => {
    await mount();
    await settle();

    expect(container.textContent).toContain('1 / 11');
    expect(container.textContent).toContain('Zap 1');
    expect(container.textContent).not.toContain('Zap 11');
    expect(container.querySelectorAll('[class*="bodycell"]')).toHaveLength(10);

    const lastPage = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '»',
    );
    if (!lastPage) throw new Error('Last-page button was not rendered.');

    await act(async () => {
      lastPage.click();
    });

    expect(container.textContent).toContain('11 / 11');
    expect(container.textContent).toContain('Zap 101');
  });

  test('reuses the shared all-time activity request when changing date filters', async () => {
    const now = Math.floor(Date.now() / 1000);
    await mount(now - 7 * 86_400);
    await settle();
    expect(fetchZapActivity).toHaveBeenCalledTimes(1);

    await mount(now - 30 * 86_400);
    await settle();
    expect(fetchZapActivity).toHaveBeenCalledTimes(1);

    await mount(now - 60 * 86_400);
    await settle();
    expect(fetchZapActivity).toHaveBeenCalledTimes(1);
    expect(fetchZapActivity).toHaveBeenCalledWith(undefined);
  });
});
