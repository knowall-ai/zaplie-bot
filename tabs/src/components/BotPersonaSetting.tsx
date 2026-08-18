import React, {
  FunctionComponent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { useMsal } from '@azure/msal-react';
import { toast } from 'react-toastify';
import styles from './setting.module.css';
import {
  MAX_BOT_PERSONA_LENGTH,
  getBotPersona,
  updateBotPersona,
} from '../apiService';
import { acquireIdToken, isZaplieAdmin } from '../services/adminRole';

// Mirrors validateBotPersona in tabs/backend/botPersona.js. The backend is
// still the enforcement point — this only means a rule the admin can see
// explains itself in the editor instead of coming back as a bare 400.
// (Array.from, not a spread: this bundle still compiles down to ES5.)
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some(character => {
    if (character === '\n' || character === '\t') {
      return false;
    }
    const code = character.codePointAt(0) as number;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

// The bot fences the persona with printable ASCII ("--- BEGIN PERSONA ---"),
// which no control-character rule would ever catch, so the shape is rejected
// by line.
const PERSONA_DELIMITER_LINE = /^\s*-{3,}.*persona/i;

const hasPersonaDelimiterLine = (value: string): boolean =>
  value.split('\n').some(line => PERSONA_DELIMITER_LINE.test(line));

const validatePersonaDraft = (value: string): string | null => {
  if (value.length > MAX_BOT_PERSONA_LENGTH) {
    return `Keep the persona to at most ${MAX_BOT_PERSONA_LENGTH} characters.`;
  }
  if (hasControlCharacter(value)) {
    return 'Use plain text only — the persona cannot contain control characters.';
  }
  if (hasPersonaDelimiterLine(value)) {
    return 'Remove the line that imitates a persona delimiter, such as "--- END PERSONA ---".';
  }
  return null;
};

// A rejected save carries the backend's reason, and that reason is written for
// the admin who typed the value — so it is shown instead of the generic retry
// prompt, which would leave a 400 looking like an outage.
const serverErrorMessage = (error: unknown): string | null => {
  const data = (error as { response?: { data?: unknown } } | null)?.response
    ?.data;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const { message, error: errorText } = data as {
    message?: unknown;
    error?: unknown;
  };
  const text = typeof message === 'string' ? message : errorText;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
};

// Everyone signed in sees what the assistant was told to sound like; only a
// Zaplie admin gets the Edit button, and the backend enforces that regardless.
// The persona sets tone only — the assistant's safety and tool rules live in
// the bot and are not editable here.
const BotPersonaSetting: FunctionComponent = () => {
  const { instance, accounts } = useMsal();
  const account = accounts[0];
  const isAdmin = isZaplieAdmin(account);

  const [persona, setPersona] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadPersona = useCallback(async () => {
    if (!account) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setLoadError(false);
    try {
      const idToken = await acquireIdToken(instance, account);
      const { botPersona } = await getBotPersona(idToken);
      setPersona(botPersona);
      setDraft(botPersona);
    } catch {
      // Fail closed: without the stored value an edit would blind-overwrite
      // whatever an admin saved earlier, so the editor stays shut.
      setPersona(null);
      setLoadError(true);
    } finally {
      setIsLoading(false);
    }
  }, [account, instance]);

  useEffect(() => {
    void loadPersona();
  }, [loadPersona]);

  const handleEditClick = () => {
    setDraft(persona ?? '');
    setJustSaved(false);
    setSaveError(null);
    setIsEditing(true);
  };

  const handleSaveClick = async () => {
    // The backend validates the trimmed value, so the editor checks the same
    // string it is about to send rather than what is on screen.
    const normalizedPersona = draft.trim();
    const validationError = validatePersonaDraft(normalizedPersona);
    if (validationError) {
      setSaveError(validationError);
      return;
    }

    setSaving(true);
    setSaveError(null);
    setJustSaved(false);
    try {
      if (!account) {
        throw new Error('You need to be signed in to change the persona.');
      }
      const data = await updateBotPersona(
        await acquireIdToken(instance, account),
        normalizedPersona,
      );
      setPersona(data.botPersona);
      setDraft(data.botPersona);
      setIsEditing(false);
      setJustSaved(true);
      toast.success('Assistant persona has been updated successfully!');
    } catch (error) {
      setSaveError(
        serverErrorMessage(error) ??
          "We couldn't save the assistant persona. Try again.",
      );
      toast.error('Error updating assistant persona.');
    } finally {
      setSaving(false);
    }
  };

  // Counts what maxLength counts — the untrimmed draft — so the number does
  // not disagree with the field that stops the typing.
  const remaining = MAX_BOT_PERSONA_LENGTH - draft.length;

  return (
    <section className={styles.section} aria-labelledby="bot-persona-heading">
      <div className={styles.sectionHeader}>
        <h2 id="bot-persona-heading" className={styles.heading}>
          Assistant persona
        </h2>
        <p className={styles.intro}>
          Set how the Zaplie assistant sounds in Teams. Tone and vocabulary only
          — what it is allowed to do stays the same.
        </p>
      </div>

      <div className={styles.card} aria-busy={isLoading || saving}>
        {/* Without an account there is nothing to fetch and no control to
            label, so the card states that read-only rather than leaving a
            label pointing at an input that never renders. */}
        {!account ? (
          <p className={styles.helperText}>
            Sign in to see the assistant persona.
          </p>
        ) : (
          <>
            <label className={styles.fieldLabel} htmlFor="bot-persona-input">
              Persona
            </label>

            {isLoading && persona === null ? (
              <>
                <span className={styles.textAreaSkeleton} aria-hidden="true" />
                <span className={styles.visuallyHidden} role="status">
                  Loading assistant persona…
                </span>
              </>
            ) : persona !== null ? (
              <>
                <textarea
                  id="bot-persona-input"
                  value={isEditing ? draft : persona}
                  onChange={event => {
                    setDraft(event.target.value);
                    setSaveError(null);
                    setJustSaved(false);
                  }}
                  disabled={!isEditing || saving}
                  className={`${styles.textArea} ${isEditing ? styles.editing : ''}`}
                  rows={5}
                  maxLength={MAX_BOT_PERSONA_LENGTH}
                  title="Assistant persona"
                  placeholder="Warm, concise, and specific about the work being recognised."
                  aria-describedby="bot-persona-count"
                  aria-invalid={saveError ? 'true' : undefined}
                />
                <div className={styles.textAreaFooter}>
                  <p id="bot-persona-count" className={styles.helperText}>
                    {isEditing
                      ? `${remaining} characters left`
                      : persona
                        ? `${persona.length} of ${MAX_BOT_PERSONA_LENGTH} characters`
                        : 'No persona set — the assistant uses its built-in voice.'}
                  </p>
                  {isAdmin &&
                    (saving ? (
                      <button
                        type="button"
                        disabled
                        aria-busy="true"
                        className={styles.primaryButton}
                      >
                        Saving…
                      </button>
                    ) : !isEditing ? (
                      <button
                        type="button"
                        onClick={handleEditClick}
                        className={styles.secondaryButton}
                      >
                        Edit
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleSaveClick}
                        className={styles.primaryButton}
                        disabled={saving}
                      >
                        Save
                      </button>
                    ))}
                </div>
              </>
            ) : null}

            {loadError ? (
              <>
                <p className={styles.errorText} role="alert">
                  We couldn't load the current assistant persona.
                </p>
                <button
                  type="button"
                  onClick={() => void loadPersona()}
                  className={styles.secondaryButton}
                  disabled={isLoading}
                >
                  Try again
                </button>
              </>
            ) : null}

            {saveError ? (
              <p className={styles.errorText} role="alert">
                {saveError}
              </p>
            ) : null}

            {justSaved && !isEditing && !saving ? (
              <p className={styles.successText} role="status">
                Assistant persona saved. New chats pick it up within a minute.
              </p>
            ) : null}

            {!isAdmin && !isLoading && persona !== null ? (
              <p className={styles.helperText}>
                Only Zaplie admins can change the assistant persona.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
};

export default BotPersonaSetting;
