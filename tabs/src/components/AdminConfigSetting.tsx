import React, {
  FormEvent,
  FunctionComponent,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useMsal } from '@azure/msal-react';
import { toast } from 'react-toastify';
import {
  getBotPersona,
  getRewardAmounts,
  getRewardName,
  updateBotPersona,
  updateRewardAmounts,
  updateRewardName,
} from '../apiService';
import { acquireIdToken, isZaplieAdmin } from '../services/adminRole';
import { RewardNameContext } from './RewardNameContext';
import styles from './setting.module.css';

interface AdminConfigDraft {
  rewardName: string;
  botPersona: string;
  githubPrMergedSats: string;
}

const EMPTY_DRAFT: AdminConfigDraft = {
  rewardName: '',
  botPersona: '',
  githubPrMergedSats: '',
};

const getErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const AdminConfigSetting: FunctionComponent = () => {
  const { instance, accounts } = useMsal();
  const { setRewardName } = useContext(RewardNameContext);
  const [draft, setDraft] = useState<AdminConfigDraft>(EMPTY_DRAFT);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const account = accounts[0];
  const isAdmin = isZaplieAdmin(account);

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      setIsLoading(true);
      setErrorMessage('');
      try {
        const { rewardName } = await getRewardName();
        if (!account || !isAdmin) {
          if (!cancelled) {
            setDraft({ ...EMPTY_DRAFT, rewardName });
          }
          return;
        }
        const idToken = await acquireIdToken(instance, account);
        const [{ rewardAmounts }, { botPersona }] = await Promise.all([
          getRewardAmounts(idToken),
          getBotPersona(idToken),
        ]);
        if (!cancelled) {
          setDraft({
            rewardName,
            botPersona,
            githubPrMergedSats: String(rewardAmounts.githubPrMergedSats),
          });
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(
            getErrorMessage(error, 'Unable to load administrator settings.'),
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    loadConfig();
    return () => {
      cancelled = true;
    };
  }, [account, instance, isAdmin]);

  const amount = Number(draft.githubPrMergedSats);
  const isAmountValid = Number.isSafeInteger(amount) && amount > 0;
  const isFormValid = draft.rewardName.trim().length > 0 && isAmountValid;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!account || !isFormValid || isSaving) {
      return;
    }

    setIsSaving(true);
    setErrorMessage('');
    try {
      const idToken = await acquireIdToken(instance, account);
      const { rewardName } = await updateRewardName(
        idToken,
        draft.rewardName.trim(),
      );
      await updateRewardAmounts(idToken, { githubPrMergedSats: amount });
      const { botPersona } = await updateBotPersona(
        idToken,
        draft.botPersona.trim(),
      );
      setDraft(current => ({ ...current, rewardName, botPersona }));
      setRewardName(rewardName);
      toast.success('Administrator settings saved.');
    } catch (error) {
      const message = getErrorMessage(
        error,
        'Unable to save administrator settings.',
      );
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <p className={styles.statusMessage}>Loading administrator settings...</p>
    );
  }

  if (!isAdmin) {
    return (
      <div className={styles.sectionHeading}>
        <h2>Rewards</h2>
        <p>Rewards on this team are called {draft.rewardName || 'sats'}.</p>
      </div>
    );
  }

  return (
    <form className={styles.adminForm} onSubmit={handleSubmit}>
      <div className={styles.sectionHeading}>
        <h2>Admin</h2>
        <p>Configure how Zaplie speaks and rewards completed work.</p>
      </div>

      {errorMessage ? (
        <p className={styles.errorMessage} role="alert">
          {errorMessage}
        </p>
      ) : null}

      <div className={styles.fieldGroup}>
        <label className={styles.label} htmlFor="reward-name">
          Reward Name
        </label>
        <input
          id="reward-name"
          type="text"
          value={draft.rewardName}
          onChange={event =>
            setDraft(current => ({
              ...current,
              rewardName: event.target.value,
            }))
          }
          className={`${styles.textBox} ${styles.compactInput}`}
          maxLength={40}
          autoComplete="off"
        />
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.label} htmlFor="bot-persona">
          Bot Persona / Prompt
        </label>
        <textarea
          id="bot-persona"
          value={draft.botPersona}
          onChange={event =>
            setDraft(current => ({
              ...current,
              botPersona: event.target.value,
            }))
          }
          className={styles.textArea}
          placeholder="Describe the bot's tone, name, and organization vocabulary"
          rows={6}
          maxLength={4000}
        />
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.label} htmlFor="github-pr-merged-sats">
          GitHub PR Merged (sats)
        </label>
        <input
          id="github-pr-merged-sats"
          type="number"
          value={draft.githubPrMergedSats}
          onChange={event =>
            setDraft(current => ({
              ...current,
              githubPrMergedSats: event.target.value,
            }))
          }
          className={`${styles.textBox} ${styles.amountInput}`}
          min={1}
          step={1}
          inputMode="numeric"
          aria-invalid={!isAmountValid}
          aria-describedby={!isAmountValid ? 'reward-amount-error' : undefined}
        />
        {!isAmountValid ? (
          <span id="reward-amount-error" className={styles.validationMessage}>
            Enter a positive whole number of sats.
          </span>
        ) : null}
      </div>

      <div className={styles.formActions}>
        <button
          type="submit"
          className={styles.saveButton}
          disabled={!isFormValid || isSaving || !account}
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  );
};

export default AdminConfigSetting;
