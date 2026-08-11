import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RewardsComponent from './RewardsComponent';
import { RewardNameContext } from './RewardNameContext';

jest.mock('../services/lnbitsServiceLocal', () => ({
  getNostrRewards: jest.fn(),
  getUserWallets: jest.fn(),
}));

describe('RewardsComponent', () => {
  test('renders the marketplace title without legacy provider branding', () => {
    const markup = renderToStaticMarkup(
      <RewardNameContext.Provider value={{ rewardName: 'sats', setRewardName: jest.fn() }}>
        <RewardsComponent adminKey="test-admin-key" userId="test-user" />
      </RewardNameContext.Provider>,
    );

    expect(markup).toContain('>Rewards</div>');
    expect(markup).not.toContain('Provided By');
  });
});
