import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

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

export async function getAchievementsFor(
  aadObjectId: string,
): Promise<AchievementsResult> {
  if (!aadObjectId) {
    throw new Error('The current user has no AAD object id.');
  }
  const response = await fetch(
    `${tabBackendApiUrl()}/achievements/for-person?aad=${encodeURIComponent(aadObjectId)}`,
    { headers: { Authorization: tabBackendAuthHeader() } },
  );
  if (!response.ok) {
    throw new Error(`Achievements fetch failed (status: ${response.status}).`);
  }
  return response.json();
}
