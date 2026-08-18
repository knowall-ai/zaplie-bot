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

export interface RewardAmountsResponse {
  rewardAmounts: Record<string, number>;
}

export interface AutomationsResponse {
  repos: string[];
}

const parseRewardAmountsResponse = (data: unknown): RewardAmountsResponse => {
  if (!data || typeof data !== 'object') {
    throw new Error('The reward amounts response was invalid.');
  }

  const rewardAmounts = (data as { rewardAmounts?: unknown }).rewardAmounts;
  if (
    !rewardAmounts ||
    typeof rewardAmounts !== 'object' ||
    Array.isArray(rewardAmounts) ||
    !Object.values(rewardAmounts).every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    )
  ) {
    throw new Error('The reward amounts response was invalid.');
  }

  return { rewardAmounts: rewardAmounts as Record<string, number> };
};

const parseAutomationsResponse = (data: unknown): AutomationsResponse => {
  if (!data || typeof data !== 'object') {
    throw new Error('The automations response was invalid.');
  }

  const repos = (data as { repos?: unknown }).repos;
  if (
    !Array.isArray(repos) ||
    !repos.every((repo) => typeof repo === 'string' && repo.length > 0)
  ) {
    throw new Error('The automations response was invalid.');
  }

  return { repos };
};

export const getRewardAmounts = async (
  idToken: string,
): Promise<RewardAmountsResponse> => {
  const response = await axios.get(`${API_URL}/reward-amounts`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseRewardAmountsResponse(response.data);
};

export const updateRewardAmounts = async (
  idToken: string,
  rewardAmounts: Record<string, number>,
): Promise<RewardAmountsResponse> => {
  const response = await axios.post(
    `${API_URL}/reward-amounts`,
    { rewardAmounts },
    {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  );
  return parseRewardAmountsResponse(response.data);
};

export const getAutomations = async (
  idToken: string,
): Promise<AutomationsResponse> => {
  const response = await axios.get(`${API_URL}/automations`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseAutomationsResponse(response.data);
};

export const updateAutomations = async (
  idToken: string,
  repos: string[],
): Promise<AutomationsResponse> => {
  const response = await axios.post(
    `${API_URL}/automations`,
    { repos },
    {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  );
  return parseAutomationsResponse(response.data);
};
