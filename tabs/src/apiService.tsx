// filepath: /c:/projects/ZapVibes/tabs/src/apiService.tsx
import axios from 'axios';

const API_URL = '/api';

export interface RewardAmounts {
  githubPrMergedSats: number;
}

export interface AdminConfig {
  rewardName: string;
  botPersona: string;
  rewardAmounts: RewardAmounts;
}

interface AdminConfigResponse {
  config: AdminConfig;
}

const bearerHeaders = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
});

export const sanitizeApiError = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    return {
      message: error.message,
      status: error.response?.status,
      code: error.code,
    };
  }
  return {
    message: error instanceof Error ? error.message : 'Unknown API error',
  };
};

export const getRewardName = async () => {
  try {
    const response = await axios.get(`${API_URL}/reward-name`);
    return response.data;
  } catch (error) {
    console.error('Error fetching reward name:', sanitizeApiError(error));
    throw error;
  }
};

export const getAdminConfig = async (
  accessToken: string,
): Promise<AdminConfigResponse> => {
  try {
    const response = await axios.get<AdminConfigResponse>(
      `${API_URL}/admin-config`,
      {
        headers: bearerHeaders(accessToken),
      },
    );
    return response.data;
  } catch (error) {
    console.error('Error fetching admin config:', sanitizeApiError(error));
    throw error;
  }
};

export const updateAdminConfig = async (
  accessToken: string,
  config: AdminConfig,
): Promise<AdminConfigResponse> => {
  try {
    const response = await axios.put<AdminConfigResponse>(
      `${API_URL}/admin-config`,
      config,
      { headers: bearerHeaders(accessToken) },
    );
    return response.data;
  } catch (error) {
    console.error('Error updating admin config:', sanitizeApiError(error));
    throw error;
  }
};
