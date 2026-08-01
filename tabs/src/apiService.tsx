// filepath: /c:/projects/ZapVibes/tabs/src/apiService.tsx
import axios from 'axios';

const API_URL = '/api';

export const getRewardName = async () => {
  try {
    console.log('Fetching reward name');
    const response = await axios.get(`${API_URL}/reward-name`);
    return response.data;
  } catch (error) {
    console.error('Error fetching reward name:', error);
    throw error;
  }
};

export const updateRewardName = async (idToken: string, newRewardName: string) => {
  try {
    const response = await axios.post(
      `${API_URL}/reward-name`,
      { newRewardName },
      {
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error updating reward name:', error);
    throw error;
  }
};
export const getRewardAmounts = async () => {
  try {
    const response = await axios.get(`${API_URL}/reward-amounts`);
    return response.data;
  } catch (error) {
    console.error('Error fetching reward amounts:', error);
    throw error;
  }
};

// Config writes authenticate with the caller's MSAL idToken; the backend
// requires the Zaplie.Admin app role carried in its roles claim.
export const updateRewardAmounts = async (idToken: string, rewardAmounts: Record<string, number>) => {
  try {
    const response = await axios.post(
      `${API_URL}/reward-amounts`,
      { rewardAmounts },
      {
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error updating reward amounts:', error);
    throw error;
  }
};

export const getAutomations = async () => {
  try {
    const response = await axios.get(`${API_URL}/automations`);
    return response.data;
  } catch (error) {
    console.error('Error fetching automations:', error);
    throw error;
  }
};

export const updateAutomations = async (idToken: string, repos: string[]) => {
  try {
    const response = await axios.post(
      `${API_URL}/automations`,
      { repos },
      {
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error updating automations:', error);
    throw error;
  }
};
