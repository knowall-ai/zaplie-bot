import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import Leaderboard from './Leaderboard';
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

const transfer = (amountSats: number): ZapTransfer => ({
  from: sender,
  to: receiver,
  transaction: {
    checking_id: `chk-${amountSats}`,
    payment_hash: `hash-${amountSats}`,
    pending: false,
    amount: -amountSats * 1000,
    fee: 0,
    memo: 'great work',
    time: Math.floor(Date.now() / 1000),
    extra: {},
    wallet_id: 'allowance-1',
  } as Transaction,
});

describe('Leaderboard', () => {
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

  test('ranks by zaps received, not by zaps sent', async () => {
    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <Leaderboard
          timestamp={0}
          transfers={[transfer(1000), transfer(200)]}
          loading={false}
          error={null}
        />,
      );
    });

    expect(container.textContent).toContain('Akash Jadhav');
    expect(container.textContent).toContain('1,200');
    expect(container.textContent).not.toContain('Wilmer Salazars');
  });
});
