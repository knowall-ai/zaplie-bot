import { logger } from '../../utils/logger';
import { nodeUrl } from './config';

const getNostrRewards = async (
  adminKey: string,
  stallId: string,
): Promise<Reward[]> => {
  try {
    const response = await fetch(
      `${nodeUrl}/nostrmarket/api/v1/stall/product/${stallId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': adminKey,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Error getting products (status: ${response.status})`);
    }

    const contentType = response.headers.get('content-type');
    logger.debug('Content-Type:', contentType);

    if (contentType && contentType.includes('application/json')) {
      const data: Reward[] = await response.json();
      logger.debug('Products:', data);
      return data;
    } else {
      const text = await response.text(); // Capture non-JSON responses
      logger.debug('Non-JSON response:', text);
      throw new Error(`Expected JSON, but got: ${text}`);
    }
  } catch (error) {
    logger.error('Error fetching rewards:', error);
    throw error;
  }
};

export { getNostrRewards };
