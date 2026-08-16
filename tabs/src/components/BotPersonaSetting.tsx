import React, {
  FormEvent,
  FunctionComponent,
  useEffect,
  useState,
} from 'react';
import { useMsal } from '@azure/msal-react';
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { getBotPersona, updateBotPersona } from '../apiService';
import { acquireIdToken, isZaplieAdmin } from '../services/adminRole';
import styles from './setting.module.css';

// Admin-only: non-admins get nothing rather than a disabled form, and the
// backend enforces the Zaplie.Admin role on the write regardless.
const BotPersonaSetting: FunctionComponent = () => {
  const { instance, accounts } = useMsal();
  const [persona, setPersona] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const account = accounts[0];
  const isAdmin = isZaplieAdmin(account);

  useEffect(() => {
    if (!account || !isAdmin) {
      setIsLoading(false);
      return;
    }
    (async () => {
      try {
        const idToken = await acquireIdToken(instance, account);
        const { botPersona } = await getBotPersona(idToken);
        setPersona(botPersona);
        setLoadError(false);
      } catch (error) {
        console.error('Bot persona load failed:', error);
        setLoadError(true);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [account, instance, isAdmin]);

  if (!account || !isAdmin) {
    return null;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      const idToken = await acquireIdToken(instance, account);
      const { botPersona } = await updateBotPersona(idToken, persona.trim());
      setPersona(botPersona);
      toast.success('Bot personality saved.');
    } catch (error) {
      console.error('Bot persona save failed:', error);
      toast.error('Unable to save the bot personality.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form className={styles.personaSetting} onSubmit={handleSubmit}>
      <label className={styles.label} htmlFor="bot-persona">
        Bot personality
      </label>
      <p className={styles.sectionHint}>
        Shapes how the assistant speaks in Teams. Leave it empty for the
        default voice.
      </p>
      {loadError ? (
        <p className={styles.errorMessage} role="alert">
          Unable to load the current bot personality. Reload the page to edit
          it.
        </p>
      ) : null}
      <textarea
        id="bot-persona"
        value={persona}
        onChange={event => setPersona(event.target.value)}
        className={styles.textArea}
        placeholder="Describe the bot's tone, name, and organization vocabulary"
        rows={6}
        maxLength={4000}
        disabled={isLoading || loadError}
      />
      <div className={styles.formActions}>
        <button
          type="submit"
          className={styles.saveButton}
          disabled={isLoading || isSaving || loadError}
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  );
};

export default BotPersonaSetting;
