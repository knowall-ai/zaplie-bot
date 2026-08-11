import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

export interface PendingReward {
  provider: string;
  providerId: string;
  recipientLabel: string;
  amountSats: number;
  reason: string;
  source: string;
}

export async function createPendingReward(
  pending: PendingReward,
): Promise<void> {
  const response = await fetch(`${tabBackendApiUrl()}/pending-rewards`, {
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
