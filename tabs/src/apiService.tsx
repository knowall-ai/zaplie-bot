import axios from 'axios';

const API_URL = '/api';

export interface RewardNameResponse {
  rewardName: string;
}

const parseRewardNameResponse = (data: unknown): RewardNameResponse => {
  if (!data || typeof data !== 'object') {
    throw new Error('The reward name response was invalid.');
  }

  const rewardName = (data as { rewardName?: unknown }).rewardName;
  if (typeof rewardName !== 'string' || !rewardName.trim()) {
    throw new Error('The reward name response was invalid.');
  }

  return { rewardName: rewardName.trim() };
};

export const getRewardName = async (): Promise<RewardNameResponse> => {
  const response = await axios.get(`${API_URL}/reward-name`);
  return parseRewardNameResponse(response.data);
};

export const updateRewardName = async (
  idToken: string,
  newRewardName: string,
): Promise<RewardNameResponse> => {
  const normalizedRewardName = newRewardName.trim();
  if (!normalizedRewardName) {
    throw new Error('The reward name cannot be empty.');
  }

  const response = await axios.post(
    `${API_URL}/reward-name`,
    { newRewardName: normalizedRewardName },
    {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  );
  return parseRewardNameResponse(response.data);
};

export const getRewardAmounts = async (idToken: string) => {
  const response = await axios.get(`${API_URL}/reward-amounts`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.data;
};

export const updateRewardAmounts = async (
  idToken: string,
  rewardAmounts: Record<string, number>,
) => {
  const response = await axios.post(
    `${API_URL}/reward-amounts`,
    { rewardAmounts },
    {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  );
  return response.data;
};

export const getAutomations = async (idToken: string) => {
  const response = await axios.get(`${API_URL}/automations`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.data;
};

export const updateAutomations = async (idToken: string, repos: string[]) => {
  const response = await axios.post(
    `${API_URL}/automations`,
    { repos },
    {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  );
  return response.data;
};
