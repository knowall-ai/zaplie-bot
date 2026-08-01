import { tabBackendAuthHeader } from './internalAuth';
const API_URL = process.env.WEBSITE_API_URL || 'http://localhost:5000/api';

export interface PendingReward {
  provider: string;
  providerId: string;
  recipientLabel: string;
  amountSats: number;
  reason: string;
  source: string;
}

// Placeholder token matches the tab backend's auth (known limitation, issue #171).
export async function createPendingReward(
  pending: PendingReward,
): Promise<void> {
  const response = await fetch(`${API_URL}/pending-rewards`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: tabBackendAuthHeader(),
    },
    body: JSON.stringify(pending),
  });
  if (!response.ok) {
    throw new Error(`pending reward write failed: ${response.status}`);
  }
}
