import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

const PERSONA_TTL_MS = 60_000;

let cached: { persona: string; fetchedAt: number } | null = null;

// Read on every bot turn, so failures degrade to the last known (or default)
// persona instead of killing the turn: the bot must not die because the portal
// backend is down or rate-limiting. Config errors still throw.
export async function getBotPersona(): Promise<string> {
  if (cached && Date.now() - cached.fetchedAt < PERSONA_TTL_MS) {
    return cached.persona;
  }
  const url = `${tabBackendApiUrl()}/bot-persona`;
  const headers = { Authorization: tabBackendAuthHeader() };
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Bot persona fetch failed (status: ${response.status}).`);
    }
    const { botPersona } = await response.json();
    if (typeof botPersona !== 'string') {
      throw new Error('Bot persona response has no botPersona string.');
    }
    cached = { persona: botPersona, fetchedAt: Date.now() };
  } catch (error) {
    const fallback = cached ? 'last known persona' : 'default instructions';
    console.error(`Bot persona refresh failed, using ${fallback}:`, error);
    // Re-stamp so a broken portal is retried once per TTL, not once per turn.
    cached = { persona: cached?.persona ?? '', fetchedAt: Date.now() };
  }
  return cached.persona;
}
