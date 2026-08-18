import axios from 'axios';
import {
  getAutomations,
  getRewardAmounts,
  getRewardName,
  updateAutomations,
  updateRewardAmounts,
  updateRewardName,
} from './apiService';

jest.mock('axios');

const mockGet = jest.mocked(axios.get);
const mockPost = jest.mocked(axios.post);

describe('reward name API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns a trimmed non-empty reward name', async () => {
    mockGet.mockResolvedValue({ data: { rewardName: '  Sats  ' } });

    await expect(getRewardName()).resolves.toEqual({ rewardName: 'Sats' });
  });

  test.each([
    undefined,
    null,
    {},
    { rewardName: '' },
    { rewardName: '   ' },
    { rewardName: 20 },
  ])('rejects an invalid reward name response: %p', async data => {
    mockGet.mockResolvedValue({ data });

    await expect(getRewardName()).rejects.toThrow(
      'The reward name response was invalid.',
    );
  });

  test('normalizes writes and validates the server response', async () => {
    mockPost.mockResolvedValue({ data: { rewardName: 'Points' } });

    await expect(updateRewardName('id-token', '  Points  ')).resolves.toEqual({
      rewardName: 'Points',
    });
    expect(mockPost).toHaveBeenCalledWith(
      '/api/reward-name',
      { newRewardName: 'Points' },
      { headers: { Authorization: 'Bearer id-token' } },
    );
  });

  test('does not send an empty reward name', async () => {
    await expect(updateRewardName('id-token', '   ')).rejects.toThrow(
      'The reward name cannot be empty.',
    );
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('reward amounts API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns validated reward amounts on read and write', async () => {
    const rewardAmounts = { pr_merged: 100, issue_closed: 50 };
    mockGet.mockResolvedValue({ data: { rewardAmounts } });
    mockPost.mockResolvedValue({ data: { message: 'ok', rewardAmounts } });

    await expect(getRewardAmounts('id-token')).resolves.toEqual({
      rewardAmounts,
    });
    await expect(
      updateRewardAmounts('id-token', rewardAmounts),
    ).resolves.toEqual({ rewardAmounts });
  });

  test.each([
    undefined,
    null,
    {},
    { rewardAmounts: null },
    { rewardAmounts: [100] },
    { rewardAmounts: { pr_merged: 'lots' } },
    { rewardAmounts: { pr_merged: Number.NaN } },
  ])('rejects an invalid reward amounts response: %p', async data => {
    mockGet.mockResolvedValue({ data });

    await expect(getRewardAmounts('id-token')).rejects.toThrow(
      'The reward amounts response was invalid.',
    );
  });
});

describe('automations API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns the validated repository list on read and write', async () => {
    mockGet.mockResolvedValue({ data: { repos: ['owner/repo'] } });
    mockPost.mockResolvedValue({
      data: { message: 'ok', repos: ['owner/repo'] },
    });

    await expect(getAutomations('id-token')).resolves.toEqual({
      repos: ['owner/repo'],
    });
    await expect(
      updateAutomations('id-token', ['owner/repo']),
    ).resolves.toEqual({ repos: ['owner/repo'] });
  });

  test.each([
    undefined,
    null,
    {},
    { repos: 'owner/repo' },
    { repos: [''] },
    { repos: [42] },
  ])('rejects an invalid automations response: %p', async data => {
    mockGet.mockResolvedValue({ data });

    await expect(getAutomations('id-token')).rejects.toThrow(
      'The automations response was invalid.',
    );
  });
});
