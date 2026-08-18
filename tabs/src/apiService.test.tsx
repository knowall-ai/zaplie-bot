import axios from 'axios';
import { getRewardName, updateRewardName } from './apiService';

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
