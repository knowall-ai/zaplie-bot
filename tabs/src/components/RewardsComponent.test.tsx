import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RewardsComponent from './RewardsComponent';
import { RewardNameContext } from './RewardNameContext';

jest.mock('@azure/msal-react', () => ({
  useMsal: () => ({ accounts: [] }),
}));

jest.mock('../services/lnbitsServiceLocal', () => ({
  getNostrRewards: jest.fn(),
  getUserWallets: jest.fn(),
}));

describe('RewardsComponent', () => {
  test('renders the marketplace title without legacy provider branding', () => {
    const view = renderToStaticMarkup(
      <RewardNameContext.Provider
        value={{ rewardName: 'sats', setRewardName: jest.fn() }}
      >
        <RewardsComponent />
      </RewardNameContext.Provider>,
    );

    expect(view).toMatch(/>\s*Rewards\s*<\/h1>/);
    expect(view).not.toContain('Provided By');
  });
});
