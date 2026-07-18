import axios from 'axios';

const API_URL = '/api/achievements';

export interface Achievement {
  id: string;
  name: string;
  description: string;
  target: number;
  current: number;
  earned: boolean;
  earnedAt: string | null;
}

export interface AchievementsResult {
  achievements: Achievement[];
  summary: { earnedCount: number; totalCount: number };
}

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
export const getMyAchievements = async (idToken: string): Promise<AchievementsResult> => {
  const response = await axios.get(`${API_URL}/me`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.data;
};
