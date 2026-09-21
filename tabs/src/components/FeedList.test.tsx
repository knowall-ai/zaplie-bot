import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import FeedList from './FeedList';
import { ZapTransfer } from '../utils/walletUtilities';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const makeUser = (id: string, displayName: string): User =>
  ({
    id,
    displayName,
    profileImg: '',
    aadObjectId: `aad-${id}`,
    email: `${id}@example.com`,
    type: 'Teammate',
    privateWallet: null,
    allowanceWallet: null,
  }) as User;

const sender = makeUser('sender-1', 'Wilmer Salazars');
const receiver = makeUser('receiver-1', 'Akash Jadhav');

const transfer = (index: number): ZapTransfer => ({
  from: sender,
  to: receiver,
  transaction: {
    checking_id: `chk-${index}`,
    payment_hash: `hash-${index}`,
    pending: false,
    amount: -(index + 1) * 1000,
    fee: 0,
    memo: `zap ${index}`,
    time: Math.floor(Date.now() / 1000) - index,
    extra: {},
    wallet_id: 'allowance-1',
  } as Transaction,
});

const transfers = (count: number): ZapTransfer[] =>
  Array.from({ length: count }, (_unused, index) => transfer(index));

describe('FeedList', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (rows: ZapTransfer[]) => {
    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <FeedList
          timestamp={0}
          transfers={rows}
          loading={false}
          error={null}
        />,
      );
    });
  };

  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find(
      candidate => candidate.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      button?.click();
    });
  };

  test('shows rows again when the row count shrinks under the current page', async () => {
    await render(transfers(25));
    await click('Last');
    expect(container.textContent).toContain('3 / 3');

    // A retry (or a narrower period) returns fewer rows: page 3 no longer
    // exists, so the feed must fall back to the last page that does.
    await render(transfers(12));

    expect(container.textContent).toContain('1 / 2');
    expect(container.textContent).not.toContain('No zaps in this period yet');
  });
});
