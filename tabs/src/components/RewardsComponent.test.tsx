import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RewardsComponent from './RewardsComponent';
import { RewardNameContext } from './RewardNameContext';

jest.mock('../services/lnbits/rewards', () => ({
  getNostrRewards: jest.fn(),
}));
jest.mock('../services/lnbits/wallets', () => ({
  getUserWallets: jest.fn(),
}));

describe('RewardsComponent', () => {
  test('renders the marketplace title without legacy provider branding', () => {
    const view = renderToStaticMarkup(
      <RewardNameContext.Provider
        value={{ rewardName: 'sats', setRewardName: jest.fn() }}
      >
        <RewardsComponent adminKey="test-admin-key" userId="test-user" />
      </RewardNameContext.Provider>,
    );

    expect(view).toMatch(/>\s*Rewards\s*<\/div>/);
    expect(view).not.toContain('Provided By');
  });
});
