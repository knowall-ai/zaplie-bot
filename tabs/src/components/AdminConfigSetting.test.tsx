import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMsal } from '@azure/msal-react';
import { getAdminConfig, updateAdminConfig } from '../apiService';
import { acquireAdminApiAccessToken } from '../services/adminApiAuth';
import AdminConfigSetting from './AdminConfigSetting';
import { RewardNameContext } from './RewardNameContext';

jest.mock('@azure/msal-react', () => ({ useMsal: jest.fn() }));
jest.mock('../apiService', () => ({
  getAdminConfig: jest.fn(),
  updateAdminConfig: jest.fn(),
}));
jest.mock('../services/adminApiAuth', () => ({
  acquireAdminApiAccessToken: jest.fn(),
  isZaplieAdmin: (
    account: { idTokenClaims?: { roles?: string[] } } | undefined,
  ) => account?.idTokenClaims?.roles?.includes('Zaplie.Admin') === true,
}));
jest.mock('react-toastify', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const mockUseMsal = useMsal as jest.MockedFunction<typeof useMsal>;
const mockGetAdminConfig = getAdminConfig as jest.MockedFunction<
  typeof getAdminConfig
>;
const mockUpdateAdminConfig = updateAdminConfig as jest.MockedFunction<
  typeof updateAdminConfig
>;
const mockAcquireToken = acquireAdminApiAccessToken as jest.MockedFunction<
  typeof acquireAdminApiAccessToken
>;

const initialConfig = {
  rewardName: 'sats',
  botPersona: 'Be concise.',
  rewardAmounts: { githubPrMergedSats: 1000 },
};

const setRewardName = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockUseMsal.mockReturnValue({
    instance: {} as never,
    accounts: [
      {
        homeAccountId: 'account-1',
        idTokenClaims: { roles: ['Zaplie.Admin'] },
      },
    ] as never,
    inProgress: 'none' as never,
    logger: {} as never,
  });
  mockAcquireToken.mockResolvedValue('api-access-token');
  mockGetAdminConfig.mockResolvedValue({ config: initialConfig });
  mockUpdateAdminConfig.mockImplementation(async (_token, config) => ({
    config,
  }));
});

const renderSetting = () =>
  render(
    <RewardNameContext.Provider value={{ rewardName: 'sats', setRewardName }}>
      <AdminConfigSetting />
    </RewardNameContext.Provider>,
  );

test('shows one Save button and submits all three settings atomically', async () => {
  renderSetting();

  const rewardName = await screen.findByLabelText('Reward Name');
  const persona = screen.getByLabelText('Bot Persona / Prompt');
  const rewardAmount = screen.getByLabelText('GitHub PR Merged (sats)');
  expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
  expect(
    screen.queryByRole('button', { name: 'Edit' }),
  ).not.toBeInTheDocument();

  fireEvent.change(rewardName, { target: { value: 'points' } });
  fireEvent.change(persona, { target: { value: 'Celebrate specific work.' } });
  fireEvent.change(rewardAmount, { target: { value: '2500' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    expect(mockUpdateAdminConfig).toHaveBeenCalledTimes(1);
  });
  expect(mockUpdateAdminConfig).toHaveBeenCalledWith('api-access-token', {
    rewardName: 'points',
    botPersona: 'Celebrate specific work.',
    rewardAmounts: { githubPrMergedSats: 2500 },
  });
  expect(setRewardName).toHaveBeenCalledWith('points');
});

test('keeps Save disabled for a non-positive or fractional amount', async () => {
  renderSetting();

  const rewardAmount = await screen.findByLabelText('GitHub PR Merged (sats)');
  fireEvent.change(rewardAmount, { target: { value: '0' } });

  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(
    screen.getByText('Enter a positive whole number of sats.'),
  ).toBeInTheDocument();
  expect(mockUpdateAdminConfig).not.toHaveBeenCalled();
});

test('does not render or fetch administrator settings for a non-admin user', () => {
  mockUseMsal.mockReturnValue({
    instance: {} as never,
    accounts: [
      { homeAccountId: 'account-1', idTokenClaims: { roles: [] } },
    ] as never,
    inProgress: 'none' as never,
    logger: {} as never,
  });

  renderSetting();

  expect(
    screen.queryByRole('button', { name: 'Save' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Reward Name')).not.toBeInTheDocument();
  expect(mockAcquireToken).not.toHaveBeenCalled();
  expect(mockGetAdminConfig).not.toHaveBeenCalled();
});
