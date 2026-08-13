import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

export async function getWebhookKeyHashes(): Promise<string[]> {
  const response = await fetch(`${tabBackendApiUrl()}/webhook-keys/hashes`, {
    headers: { Authorization: tabBackendAuthHeader() },
  });
  if (!response.ok) {
    throw new Error(`webhook key hashes fetch failed: ${response.status}`);
  }
  const data = await response.json();
  return data.hashes;
}
