import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

export interface PendingReward {
  provider: string;
  providerId: string;
  recipientLabel: string;
  amountSats: number;
  reason: string;
  source: string;
}

/**
 * The pending-reward request reached the network but did not come back with a
 * clear answer (connection lost, or a 5xx), so the portal may have stored it.
 * The portal's POST is not idempotent: retrying could queue the reward twice.
 */
export class PendingRewardWriteUncertainError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PendingRewardWriteUncertainError';
  }
}

/**
 * Records a reward for a recipient who has not linked their account yet.
 *
 * @throws Error when the request was never sent (missing configuration) or the
 *   portal rejected it with a 4xx, so nothing was stored and a retry is safe
 * @throws PendingRewardWriteUncertainError when the outcome is unknown
 */
export async function createPendingReward(
  pending: PendingReward,
): Promise<void> {
  // Resolved before the request, so a configuration error is a plain error.
  const url = `${tabBackendApiUrl()}/pending-rewards`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: tabBackendAuthHeader(),
  };
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(pending),
    });
  } catch (error) {
    throw new PendingRewardWriteUncertainError(
      'The pending reward request failed after being sent to the portal.',
      error,
    );
  }
  if (response.status >= 400 && response.status < 500) {
    // The portal (or its rate limiter) refused the request: nothing stored.
    throw new Error(`pending reward write failed: ${response.status}`);
  }
  if (!response.ok) {
    throw new PendingRewardWriteUncertainError(
      `pending reward write returned ${response.status}; it may have been stored`,
    );
  }
}
