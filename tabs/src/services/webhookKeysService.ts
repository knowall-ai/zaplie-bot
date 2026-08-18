import axios from 'axios';

const API_URL = '/api/webhook-keys';

export interface WebhookKey {
  id: string;
  label: string;
  last4: string;
  createdAt: string;
  revokedAt: string | null;
}

export const parseWebhookKeys = (value: unknown): WebhookKey[] => {
  if (!value || typeof value !== 'object') {
    throw new Error('Webhook keys response is malformed.');
  }

  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) {
    throw new Error('Webhook keys response is malformed.');
  }

  return keys as WebhookKey[];
};

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
export const getWebhookKeys = async (
  idToken: string,
): Promise<WebhookKey[]> => {
  const response = await axios.get(API_URL, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseWebhookKeys(response.data);
};

export const createWebhookKey = async (
  idToken: string,
  label: string,
): Promise<{ key: string; id: string }> => {
  const response = await axios.post(
    API_URL,
    { label },
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  return response.data;
};

export const revokeWebhookKey = async (
  idToken: string,
  id: string,
): Promise<void> => {
  await axios.post(`${API_URL}/${id}/revoke`, null, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
};
