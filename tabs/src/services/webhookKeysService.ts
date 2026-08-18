import axios from 'axios';

const API_URL = '/api/webhook-keys';

export interface WebhookKey {
  id: string;
  label: string;
  last4: string;
  createdAt: string;
  revokedAt: string | null;
}

interface CreatedWebhookKey {
  key: string;
  id: string;
}

const isWebhookKey = (value: unknown): value is WebhookKey => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<WebhookKey>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.last4 === 'string' &&
    typeof candidate.createdAt === 'string' &&
    (candidate.revokedAt === null || typeof candidate.revokedAt === 'string')
  );
};

export const parseWebhookKeys = (value: unknown): WebhookKey[] => {
  if (!value || typeof value !== 'object') {
    throw new Error('Webhook keys response is malformed.');
  }

  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || !keys.every(isWebhookKey)) {
    throw new Error('Webhook keys response is malformed.');
  }

  return keys;
};

export const parseCreatedWebhookKey = (value: unknown): CreatedWebhookKey => {
  if (!value || typeof value !== 'object') {
    throw new Error('Created webhook key response is malformed.');
  }

  const candidate = value as Partial<CreatedWebhookKey>;
  if (typeof candidate.key !== 'string' || typeof candidate.id !== 'string') {
    throw new Error('Created webhook key response is malformed.');
  }

  return { key: candidate.key, id: candidate.id };
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
): Promise<CreatedWebhookKey> => {
  const response = await axios.post(
    API_URL,
    { label },
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  return parseCreatedWebhookKey(response.data);
};

export const revokeWebhookKey = async (
  idToken: string,
  id: string,
): Promise<void> => {
  await axios.post(`${API_URL}/${id}/revoke`, null, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
};
