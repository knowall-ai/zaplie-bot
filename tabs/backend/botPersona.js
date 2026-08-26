// The bot persona is an LLM system prompt fragment written by an admin, so it
// is validated here rather than at the route: it must stay short and plain
// text. The bot keeps its safety rails outside this value — the persona only
// sets tone and vocabulary.
//
// What actually keeps a forged fence harmless is the composition in
// src/services/foundryAgentService.ts: the fixed guardrails are stated before
// the persona block AND re-asserted after it, so closing the fence early buys
// an attacker nothing — the constraints are still the last thing the model
// reads. The checks below are defense in depth on top of that invariant, not
// the thing standing between the persona and the rules.
const MAX_BOT_PERSONA_LENGTH = 2000;

// Tab and newline are the only control characters a written personality needs;
// the rest of C0/C1 has no place in prose. Checked by code point rather than a
// regex literal so the rule stays readable (and greppable) instead of a row of
// escapes.
const hasControlCharacter = value =>
  [...value].some(character => {
    if (character === '\n' || character === '\t') {
      return false;
    }
    const code = character.codePointAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

// The fence the bot builds is printable ASCII — "--- BEGIN PERSONA ---" and
// "--- END PERSONA ---" — so the control-character rule above never sees it.
// Match the shape instead: a line that opens with a run of dashes and then
// mentions the persona, which covers both ends of the fence and the variants
// around them.
const PERSONA_DELIMITER_LINE = /^\s*-{3,}.*persona/i;

const hasPersonaDelimiterLine = value =>
  value.split('\n').some(line => PERSONA_DELIMITER_LINE.test(line));

// CRLF and lone CR come from pasting out of Windows editors; the stored value
// is normalized so a round trip never changes what the admin saw.
const normalizeBotPersona = value => value.replace(/\r\n?/g, '\n').trim();

const validateBotPersona = value => {
  if (typeof value !== 'string') {
    return { valid: false, message: 'botPersona must be a string' };
  }

  const botPersona = normalizeBotPersona(value);
  // Code points, not UTF-16 units, so an emoji is not billed twice against a
  // limit the message states in characters.
  if ([...botPersona].length > MAX_BOT_PERSONA_LENGTH) {
    return {
      valid: false,
      message: `botPersona must be at most ${MAX_BOT_PERSONA_LENGTH} characters`,
    };
  }
  if (hasControlCharacter(botPersona)) {
    return {
      valid: false,
      message: 'botPersona must be plain text without control characters',
    };
  }
  if (hasPersonaDelimiterLine(botPersona)) {
    return {
      valid: false,
      message: 'botPersona must not contain a persona delimiter line',
    };
  }

  return { valid: true, botPersona };
};

// A stored value can predate a rule change (or be hand-edited in data.json), so
// reads sanitize too instead of trusting whatever is on disk. Dropping it
// silently would look like "the admin never saved anything", so the reason is
// logged — never the value, which is exactly the text under suspicion.
const readStoredBotPersona = stored => {
  const validation = validateBotPersona(stored ?? '');
  if (!validation.valid) {
    const length = typeof stored === 'string' ? stored.length : 'n/a';
    console.warn(
      `Ignoring the stored botPersona: ${validation.message} (length: ${length})`,
    );
    return '';
  }
  return validation.botPersona;
};

module.exports = {
  MAX_BOT_PERSONA_LENGTH,
  validateBotPersona,
  readStoredBotPersona,
};
