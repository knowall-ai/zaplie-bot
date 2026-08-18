import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

// How stale the persona may get. Every turn asks for it, so this is what caps
// the traffic: one request per minute per process, not one per message. An
// admin's save therefore reaches the assistant within a minute without a
// redeploy.
export const PERSONA_TTL_MS = 60_000;

// "No persona configured", not "the default persona" — the actual default text
// lives in foundryAgentService.ts as DEFAULT_PERSONA and is substituted when
// this value is empty. Named apart so the two never read as the same thing.
const NO_PERSONA = '';

// Same rules as validateBotPersona in tabs/backend/botPersona.js — the limit,
// the control-character set and the delimiter regex are kept character-for-
// character identical across the two packages. The bot re-checks instead of
// trusting the response, because whatever comes back here is spliced into a
// system prompt.
const MAX_PERSONA_LENGTH = 2000;

const isPlainText = (value: string): boolean =>
  [...value].every(character => {
    if (character === '\n' || character === '\t') {
      return true;
    }
    const code = character.codePointAt(0) as number;
    return code >= 0x20 && (code < 0x7f || code > 0x9f);
  });

// The fence buildInstructions() puts around the persona is printable ASCII, so
// isPlainText never sees it. Reject the shape by line instead — the same rule
// the portal applies on write, repeated here because a persona can also arrive
// from a hand-edited data.json.
const PERSONA_DELIMITER_LINE = /^\s*-{3,}.*persona/i;

const hasPersonaDelimiterLine = (value: string): boolean =>
  value.split('\n').some(line => PERSONA_DELIMITER_LINE.test(line));

let cached: { persona: string; fetchedAt: number } | null = null;

const fetchPersona = async (): Promise<string> => {
  const response = await fetch(`${tabBackendApiUrl()}/bot-persona`, {
    headers: { Authorization: tabBackendAuthHeader() },
  });
  if (!response.ok) {
    throw new Error(`bot persona fetch failed: ${response.status}`);
  }
  const { botPersona } = await response.json();
  if (typeof botPersona !== 'string') {
    throw new Error('bot persona response has no botPersona string');
  }
  const persona = botPersona.replace(/\r\n?/g, '\n').trim();
  if (
    persona.length > MAX_PERSONA_LENGTH ||
    !isPlainText(persona) ||
    hasPersonaDelimiterLine(persona)
  ) {
    throw new Error('bot persona response failed validation');
  }
  return persona;
};

// Fails open by design: a portal outage, a rate-limit, a missing
// TAB_BACKEND_TOKEN — none of them may kill a bot turn. The worst case is that
// the assistant answers in its built-in voice.
export async function getBotPersona(): Promise<string> {
  if (cached && Date.now() - cached.fetchedAt < PERSONA_TTL_MS) {
    return cached.persona;
  }
  try {
    cached = { persona: await fetchPersona(), fetchedAt: Date.now() };
  } catch (error) {
    const fallback = cached ? 'last known persona' : 'built-in persona';
    console.error(`Bot persona refresh failed, using the ${fallback}:`, error);
    // Re-stamp so a broken portal is retried once per TTL, not once per turn.
    cached = {
      persona: cached?.persona ?? NO_PERSONA,
      fetchedAt: Date.now(),
    };
  }
  return cached.persona;
}
