import { apiRequest } from './gateway';
import { getNostrRewards } from './rewards';

jest.mock('./gateway', () => ({
  apiRequest: jest.fn(),
}));

const mockApiRequest = apiRequest as jest.MockedFunction<typeof apiRequest>;

describe('lnbits rewards', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
  });

  test('reads the stall products through the gateway', async () => {
    mockApiRequest.mockResolvedValueOnce([
      { id: 'product-1', name: 'Coffee', price: 500 },
    ]);

    const rewards = await getNostrRewards('stall-1');

    expect(rewards[0].name).toBe('Coffee');
    expect(mockApiRequest).toHaveBeenCalledWith('/rewards/stall-1');
  });

  test('propagates a gateway failure', async () => {
    mockApiRequest.mockRejectedValueOnce(
      new Error('Request failed with status 404'),
    );

    await expect(getNostrRewards('stall-1')).rejects.toThrow('status 404');
  });
});
