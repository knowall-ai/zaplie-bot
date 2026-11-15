import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import RewardsComponent from './RewardsComponent';
import { getNostrRewards } from '../services/wallet/rewards';
import { RewardNameContext } from './RewardNameContext';

jest.mock('@azure/msal-react', () => ({
  useMsal: () => ({
    instance: { getActiveAccount: () => null },
    accounts: [],
  }),
}));

jest.mock('../services/wallet/rewards', () => ({
  getNostrRewards: jest.fn(),
}));
jest.mock('../services/wallet/users', () => ({
  getUsers: jest.fn(),
}));
jest.mock('../services/wallet/wallets', () => ({
  getUserWallets: jest.fn(),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockGetNostrRewards = getNostrRewards as jest.MockedFunction<
  typeof getNostrRewards
>;

const goodReward = {
  id: 'reward-1',
  image: '',
  name: 'Coffee',
  shortDescription: 'A good coffee',
  link: '',
  price: 100,
};

const rewardName = {
  rewardName: 'sats',
  rewardNameLabel: 'sats',
  setRewardName: jest.fn(),
};

describe('RewardsComponent', () => {
  test('renders the marketplace title without legacy provider branding', () => {
    const view = renderToStaticMarkup(
      <RewardNameContext.Provider value={rewardName}>
        <RewardsComponent />
      </RewardNameContext.Provider>,
    );

    expect(view).toMatch(/>\s*Rewards\s*<\/h1>/);
    expect(view).not.toContain('Provided By');
  });

  test('drops a malformed reward instead of failing the whole tab', async () => {
    // One bad product must not take the catalogue down with it.
    process.env.REACT_APP_LNBITS_STORE_ID = 'store-1';
    mockGetNostrRewards.mockResolvedValue([
      goodReward,
      { ...goodReward, id: 'reward-2', shortDescription: undefined },
      { ...goodReward, id: 'reward-3', price: 'free' },
      { ...goodReward, id: undefined, name: 'No id' },
    ] as unknown as Reward[]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      // This test uses React's raw createRoot API, which is not auto-wrapped.
      // eslint-disable-next-line testing-library/no-unnecessary-act
      await act(async () => {
        root.render(
          <RewardNameContext.Provider value={rewardName}>
            <RewardsComponent />
          </RewardNameContext.Provider>,
        );
      });

      expect(container.textContent).toContain('Coffee');
      expect(container.textContent).toContain(
        '3 rewards could not be displayed',
      );
      expect(container.textContent).not.toContain('NaN');
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      // A failed assertion must still detach the container, or it leaks into
      // the next test that shares this document.
      // eslint-disable-next-line testing-library/no-unnecessary-act
      await act(async () => root.unmount());
      container.remove();
      delete process.env.REACT_APP_LNBITS_STORE_ID;
    }
  });

  test('fails closed when the rewards store is not configured', async () => {
    // REACT_APP_LNBITS_STORE_ID is unset under test, which is the
    // misconfigured-environment path: no silent empty marketplace.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      // This test uses React's raw createRoot API, which is not auto-wrapped.
      // eslint-disable-next-line testing-library/no-unnecessary-act
      await act(async () => {
        root.render(
          <RewardNameContext.Provider value={rewardName}>
            <RewardsComponent />
          </RewardNameContext.Provider>,
        );
      });

      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'Rewards are not configured for this environment.',
      );
      expect(container.textContent).not.toContain('No rewards are available.');
      expect(container.textContent).not.toContain('Loading rewards');
    } finally {
      // eslint-disable-next-line testing-library/no-unnecessary-act
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
