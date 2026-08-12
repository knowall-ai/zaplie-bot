import axios from 'axios';

const API_URL = '/api/webhook-keys';

export interface WebhookKey {
  id: string;
  label: string;
  last4: string;
  createdAt: string;
  revokedAt: string | null;
}

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
export const getWebhookKeys = async (
  idToken: string,
): Promise<WebhookKey[]> => {
  const response = await axios.get(API_URL, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.data.keys;
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
