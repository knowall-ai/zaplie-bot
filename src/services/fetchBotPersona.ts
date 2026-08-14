import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

export async function getBotPersona(): Promise<string> {
  const response = await fetch(`${tabBackendApiUrl()}/bot-persona`, {
    headers: { Authorization: tabBackendAuthHeader() },
  });
  if (!response.ok) {
    throw new Error(`Bot persona fetch failed (status: ${response.status}).`);
  }
  const { botPersona } = await response.json();
  if (typeof botPersona !== 'string') {
    throw new Error('Bot persona response has no botPersona string.');
  }
  return botPersona;
}
