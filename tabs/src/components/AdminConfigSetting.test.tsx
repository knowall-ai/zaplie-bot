import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMsal } from '@azure/msal-react';
import {
  getAutomations,
  getBotPersona,
  getRewardAmounts,
  getRewardName,
  updateBotPersona,
  updateRewardAmounts,
  updateRewardName,
} from '../apiService';
import { acquireIdToken } from '../services/adminRole';
import AdminConfigSetting from './AdminConfigSetting';
import { RewardNameContext } from './RewardNameContext';

jest.mock('@azure/msal-react', () => ({ useMsal: jest.fn() }));
jest.mock('../apiService', () => ({
  getAutomations: jest.fn(),
  getRewardName: jest.fn(),
  getRewardAmounts: jest.fn(),
  getBotPersona: jest.fn(),
  updateRewardName: jest.fn(),
  updateRewardAmounts: jest.fn(),
  updateBotPersona: jest.fn(),
}));
jest.mock('../services/adminRole', () => ({
  acquireIdToken: jest.fn(),
  isZaplieAdmin: (
    account: { idTokenClaims?: { roles?: string[] } } | undefined,
  ) => account?.idTokenClaims?.roles?.includes('Zaplie.Admin') === true,
}));
jest.mock('react-toastify', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const mockUseMsal = useMsal as jest.MockedFunction<typeof useMsal>;
const mockGetAutomations = getAutomations as jest.MockedFunction<
  typeof getAutomations
>;
const mockGetRewardName = getRewardName as jest.MockedFunction<
  typeof getRewardName
>;
const mockGetRewardAmounts = getRewardAmounts as jest.MockedFunction<
  typeof getRewardAmounts
>;
const mockGetBotPersona = getBotPersona as jest.MockedFunction<
  typeof getBotPersona
>;
const mockUpdateRewardName = updateRewardName as jest.MockedFunction<
  typeof updateRewardName
>;
const mockUpdateRewardAmounts = updateRewardAmounts as jest.MockedFunction<
  typeof updateRewardAmounts
>;
const mockUpdateBotPersona = updateBotPersona as jest.MockedFunction<
  typeof updateBotPersona
>;
const mockAcquireIdToken = acquireIdToken as jest.MockedFunction<
  typeof acquireIdToken
>;

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
  mockAcquireIdToken.mockResolvedValue('fresh-id-token');
  mockGetAutomations.mockResolvedValue({ repos: ['org/repo-a', 'org/repo-b'] });
  mockGetRewardName.mockResolvedValue({ rewardName: 'sats' });
  mockGetRewardAmounts.mockResolvedValue({
    rewardAmounts: { githubPrMergedSats: 1000 },
  });
  mockGetBotPersona.mockResolvedValue({ botPersona: 'Be concise.' });
  mockUpdateRewardName.mockImplementation(async (_token, newRewardName) => ({
    rewardName: newRewardName,
  }));
  mockUpdateRewardAmounts.mockImplementation(async (_token, rewardAmounts) => ({
    rewardAmounts,
  }));
  mockUpdateBotPersona.mockImplementation(async (_token, botPersona) => ({
    botPersona,
  }));
});

const renderSetting = () =>
  render(
    <RewardNameContext.Provider value={{ rewardName: 'sats', setRewardName }}>
      <AdminConfigSetting />
    </RewardNameContext.Provider>,
  );

test('shows one Save button and submits all three settings with one click', async () => {
  renderSetting();

  const rewardName = await screen.findByLabelText('Reward name');
  const persona = screen.getByLabelText('Persona prompt');
  const rewardAmount = screen.getByLabelText('GitHub PR merged');
  expect(
    screen.getByText(
      'Automated rewards currently watch 2 connected repositories.',
    ),
  ).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
  expect(
    screen.queryByRole('button', { name: 'Edit' }),
  ).not.toBeInTheDocument();

  fireEvent.change(rewardName, { target: { value: 'points' } });
  fireEvent.change(persona, { target: { value: 'Celebrate specific work.' } });
  fireEvent.change(rewardAmount, { target: { value: '2500' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    expect(mockUpdateBotPersona).toHaveBeenCalledTimes(1);
  });
  expect(mockUpdateRewardName).toHaveBeenCalledWith('fresh-id-token', 'points');
  expect(mockUpdateRewardAmounts).toHaveBeenCalledWith('fresh-id-token', {
    githubPrMergedSats: 2500,
  });
  expect(mockUpdateBotPersona).toHaveBeenCalledWith(
    'fresh-id-token',
    'Celebrate specific work.',
  );
  expect(setRewardName).toHaveBeenCalledWith('points');
});

test('keeps Save disabled for a non-positive or fractional amount', async () => {
  renderSetting();

  const rewardAmount = await screen.findByLabelText('GitHub PR merged');
  fireEvent.change(rewardAmount, { target: { value: '0' } });

  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(
    screen.getByText('Enter a positive whole number of sats.'),
  ).toBeInTheDocument();
  expect(mockUpdateRewardName).not.toHaveBeenCalled();
});

test('shows the reward name read-only and fetches nothing admin-gated for a non-admin', async () => {
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
    await screen.findByText('Rewards on this team are called sats.'),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Save' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Reward name')).not.toBeInTheDocument();
  expect(mockAcquireIdToken).not.toHaveBeenCalled();
  expect(mockGetRewardAmounts).not.toHaveBeenCalled();
  expect(mockGetBotPersona).not.toHaveBeenCalled();
  expect(mockGetAutomations).not.toHaveBeenCalled();
});

test('still renders the form without the repository line when that read fails', async () => {
  mockGetAutomations.mockRejectedValue(new Error('automations down'));

  renderSetting();

  expect(await screen.findByLabelText('Reward name')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(
    screen.queryByText(/Automated rewards currently watch/),
  ).not.toBeInTheDocument();
});
