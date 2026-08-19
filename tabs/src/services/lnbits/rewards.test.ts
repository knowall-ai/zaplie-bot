import {
  errorResponse,
  installFetchMock,
  jsonResponse,
  textResponse,
} from '../../testUtils/fetchMock';
import { getNostrRewards } from './rewards';

describe('lnbits rewards', () => {
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    mockFetch = installFetchMock();
  });

  test('returns the products for the stall', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([{ id: 'product-1', name: 'Coffee', price: 500 }]),
    );

    const rewards = await getNostrRewards('admin-key', 'stall-1');

    expect(rewards).toHaveLength(1);
    expect(rewards[0].name).toBe('Coffee');
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      '/nostrmarket/api/v1/stall/product/stall-1',
    );
  });

  test('throws when the stall endpoint fails', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

    await expect(getNostrRewards('admin-key', 'stall-1')).rejects.toThrow(
      'status: 404',
    );
  });

  test('throws when the response is not JSON', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('<html>nostrmarket</html>'));

    await expect(getNostrRewards('admin-key', 'stall-1')).rejects.toThrow(
      'Expected JSON',
    );
  });
});
