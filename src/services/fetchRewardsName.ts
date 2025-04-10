// filepath: /c:/projects/ZapVibes/src/services/fetchRewardsName.ts
const API_URL = process.env.WEBSITE_API_URL || 'http://localhost:5000/api';

// Example: Get the authentication token (replace with actual logic)
const getAuthToken = () => {
  return 'your-secret-token'; // Replace with actual token retrieval logic
};

export const getRewardName = async () => {
  try {
    console.log(API_URL);
    const response = await fetch(`${API_URL}/reward-name`, {
      method: 'GET',
      headers: {
        'Authorization': getAuthToken(),
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