// filepath: /c:/projects/ZapVibes/tabs/src/apiService.tsx
import axios from 'axios';

const API_URL = '/api';

// Example: Get the authentication token (replace with actual logic)
const getAuthToken = () => {
  return 'your-secret-token'; // Replace with actual token retrieval logic
};

export const getRewardName = async () => {
  try {
    console.log('Fetching reward name');
    const response = await axios.get(`${API_URL}/reward-name`, {
      headers: {
        Authorization: getAuthToken(),
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching reward name:', error);
    throw error;
  }
};

export const updateRewardName = async (newRewardName: string) => {
  try {
    const response = await axios.post(
      `${API_URL}/reward-name`,
      { newRewardName },
      {
        headers: {
          Authorization: getAuthToken(),
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error updating reward name:', error);
    throw error;
  }
};

export const getBotPersona = async () => {
  try {
    const response = await axios.get(`${API_URL}/bot-persona`, {
      headers: {
        Authorization: getAuthToken(),
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching bot persona:', error);
    throw error;
  }
};

export const updateBotPersona = async (botPersona: string) => {
  try {
    const response = await axios.post(
      `${API_URL}/bot-persona`,
      { botPersona },
      {
        headers: {
          Authorization: getAuthToken(),
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error updating bot persona:', error);
    throw error;
  }
};

export const getRewardAmounts = async () => {
  try {
    const response = await axios.get(`${API_URL}/reward-amounts`, {
      headers: {
        Authorization: getAuthToken(),
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching reward amounts:', error);
    throw error;
  }
};

export const updateRewardAmounts = async (rewardAmounts: Record<string, number>) => {
  try {
    const response = await axios.post(
      `${API_URL}/reward-amounts`,
      { rewardAmounts },
      {
        headers: {
          Authorization: getAuthToken(),
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error updating reward amounts:', error);
    throw error;
  }
};