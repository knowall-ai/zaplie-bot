import axios from 'axios';

const API_URL = '/api/team-rewards';

export interface TeamReward {
  id: string;
  category: string;
  name: string;
  description: string;
  priceSats: number;
}

export interface RedemptionHistoryEntry {
  id: string;
  rewardName: string;
  personName: string;
  priceSats: number;
  status: 'requested' | 'fulfilled';
  requestedAt: string;
  fulfilledAt: string | null;
}

export interface TeamRewardsResponse {
  rewards: TeamReward[];
  myRequests: string[];
  history: RedemptionHistoryEntry[];
}

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
export const getTeamRewards = async (idToken: string): Promise<TeamRewardsResponse> => {
  const response = await axios.get(API_URL, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.data;
};

export const redeemTeamReward = async (idToken: string, rewardId: string): Promise<void> => {
  await axios.post(`${API_URL}/${rewardId}/redeem`, null, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
};

export const fulfillRedemption = async (idToken: string, redemptionId: string): Promise<void> => {
  await axios.post(`${API_URL}/redemptions/${redemptionId}/fulfill`, null, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
};
