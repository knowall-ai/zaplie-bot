const API_URL = process.env.WEBSITE_API_URL || 'http://localhost:5000/api';

// Placeholder token matches the tab backend's auth (known limitation, issue #171).
export async function getRewardAmounts(): Promise<Record<string, number>> {
  const response = await fetch(`${API_URL}/reward-amounts`, {
    headers: { Authorization: 'your-secret-token' },
  });
  if (!response.ok) {
    throw new Error(`reward amounts fetch failed: ${response.status}`);
  }
  const data = await response.json();
  return data.rewardAmounts;
}
