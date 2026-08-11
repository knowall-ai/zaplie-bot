import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

export async function getAutomations(): Promise<{ repos: string[] }> {
  const response = await fetch(`${tabBackendApiUrl()}/automations`, {
    headers: { Authorization: tabBackendAuthHeader() },
  });
  if (!response.ok) {
    throw new Error(`automations fetch failed: ${response.status}`);
  }
  const data = await response.json();
  return { repos: data.repos };
}
