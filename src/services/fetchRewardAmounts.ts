import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

export async function getRewardAmounts(): Promise<Record<string, number>> {
  const response = await fetch(`${tabBackendApiUrl()}/reward-amounts`, {
    headers: { Authorization: tabBackendAuthHeader() },
  });
  if (!response.ok) {
    throw new Error(`reward amounts fetch failed: ${response.status}`);
  }
  const data = await response.json();
  return data.rewardAmounts;
}
