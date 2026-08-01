import { tabBackendAuthHeader } from './internalAuth';
const API_URL = process.env.WEBSITE_API_URL || 'http://localhost:5000/api';

// Placeholder token matches the tab backend's auth (known limitation, issue #171).
export async function getWebhookKeyHashes(): Promise<string[]> {
  const response = await fetch(`${API_URL}/webhook-keys/hashes`, {
    headers: { Authorization: tabBackendAuthHeader() },
  });
  if (!response.ok) {
    throw new Error(`webhook key hashes fetch failed: ${response.status}`);
  }
  const data = await response.json();
  return data.hashes;
}
