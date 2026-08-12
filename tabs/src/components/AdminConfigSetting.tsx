import React, {
  FormEvent,
  FunctionComponent,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useMsal } from '@azure/msal-react';
import { toast } from 'react-toastify';
import { AdminConfig, getAdminConfig, updateAdminConfig } from '../apiService';
import {
  acquireAdminApiAccessToken,
  isZaplieAdmin,
} from '../services/adminApiAuth';
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

const toDraft = (config: AdminConfig): AdminConfigDraft => ({
  rewardName: config.rewardName,
  botPersona: config.botPersona,
  githubPrMergedSats: String(config.rewardAmounts.githubPrMergedSats),
});

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
      if (!account || !isAdmin) {
        return;
      }

      setIsLoading(true);
      setErrorMessage('');
      try {
        const accessToken = await acquireAdminApiAccessToken(instance, account);
        const { config } = await getAdminConfig(accessToken);
        if (!cancelled) {
          setDraft(toDraft(config));
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

    const config: AdminConfig = {
      rewardName: draft.rewardName.trim(),
      botPersona: draft.botPersona.trim(),
      rewardAmounts: { githubPrMergedSats: amount },
    };

    setIsSaving(true);
    setErrorMessage('');
    try {
      const accessToken = await acquireAdminApiAccessToken(instance, account);
      const { config: savedConfig } = await updateAdminConfig(
        accessToken,
        config,
      );
      setDraft(toDraft(savedConfig));
      setRewardName(savedConfig.rewardName);
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

  if (!isAdmin) {
    return null;
  }

  if (isLoading) {
    return (
      <p className={styles.statusMessage}>Loading administrator settings...</p>
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
