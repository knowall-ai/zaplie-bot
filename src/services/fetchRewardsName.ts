import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

export const getRewardName = async () => {
  try {
    const response = await fetch(`${tabBackendApiUrl()}/reward-name`, {
      method: 'GET',
      headers: {
        'Authorization': tabBackendAuthHeader(),
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error('Network response was not ok');
    }

    const data = await response.json();
    return data.rewardName;
  } catch (error) {
    console.error('Error fetching reward name:', error);
    throw error;
  }
};
