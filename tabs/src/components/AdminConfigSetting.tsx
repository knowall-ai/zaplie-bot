import React, {
  FormEvent,
  FunctionComponent,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useMsal } from '@azure/msal-react';
import { toast } from 'react-toastify';
import {
  getAutomations,
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

const AdminConfigSetting: FunctionComponent = () => {
  const { instance, accounts } = useMsal();
  const { setRewardName } = useContext(RewardNameContext);
  const [draft, setDraft] = useState<AdminConfigDraft>(EMPTY_DRAFT);
  const [repoCount, setRepoCount] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const account = accounts[0];
  const isAdmin = isZaplieAdmin(account);

  const loadConfig = useCallback(async () => {
    const { rewardName } = await getRewardName();
    if (!account || !isAdmin) {
      setDraft({ ...EMPTY_DRAFT, rewardName });
      return;
    }
    const idToken = await acquireIdToken(instance, account);
    // The repository count is an optional context line; its failure must
    // not block the admin form, and getAutomations already logs it.
    const [{ rewardAmounts }, { botPersona }, automations] = await Promise.all([
      getRewardAmounts(idToken),
      getBotPersona(idToken),
      getAutomations(idToken).catch(() => null),
    ]);
    setDraft({
      rewardName,
      botPersona,
      githubPrMergedSats: String(rewardAmounts.githubPrMergedSats),
    });
    setRepoCount(automations ? automations.repos.length : null);
    setRewardName(rewardName);
  }, [account, instance, isAdmin, setRewardName]);

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      setErrorMessage('');
      try {
        await loadConfig();
      } catch (error) {
        console.error('Admin settings load failed:', error);
        setErrorMessage('Unable to load administrator settings.');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [loadConfig]);

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
      console.error('Admin settings save failed:', error);
      toast.error('Unable to save administrator settings.');
      // The three writes are sequential, so a failure can leave the backend
      // partially updated; reload so the form shows what actually persisted.
      try {
        await loadConfig();
        setErrorMessage(
          'Saving failed partway. The values below are what the server has.',
        );
      } catch (reloadError) {
        console.error('Admin settings reload failed:', reloadError);
        setErrorMessage('Unable to save administrator settings.');
      }
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
      <section className={styles.settingCard}>
        <div className={styles.sectionBlock}>
          <div className={styles.sectionHeading}>
            <h2>Rewards</h2>
            <p>Rewards on this team are called {draft.rewardName || 'sats'}.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <form className={styles.settingCard} onSubmit={handleSubmit}>
      <div className={styles.cardHeader}>
        <div className={styles.sectionHeading}>
          <h2>Admin</h2>
          <p>Configure how Zaplie speaks and rewards completed work.</p>
        </div>
      </div>

      {errorMessage ? (
        <div className={styles.sectionBlock}>
          <p className={styles.errorMessage} role="alert">
            {errorMessage}
          </p>
        </div>
      ) : null}

      <div className={styles.sectionBlock}>
        <h3 className={styles.sectionTitle}>Bot personality</h3>
        <p className={styles.sectionHint}>
          Shapes how the assistant speaks in Teams. Leave it empty for the
          default voice.
        </p>
        <div className={styles.fieldGroup}>
          <label className={styles.label} htmlFor="bot-persona">
            Persona prompt
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
      </div>

      <div className={styles.sectionBlock}>
        <h3 className={styles.sectionTitle}>Rewards</h3>
        <p className={styles.sectionHint}>
          What recognition is called across the portal, and what automated work
          pays out.
        </p>
        <div className={styles.fieldsRow}>
          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="reward-name">
              Reward name
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
            <label className={styles.label} htmlFor="github-pr-merged-sats">
              GitHub PR merged
            </label>
            <span className={styles.unitField}>
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
                aria-describedby={
                  !isAmountValid ? 'reward-amount-error' : undefined
                }
              />
              <span className={styles.unitSuffix} aria-hidden="true">
                sats
              </span>
            </span>
            {!isAmountValid ? (
              <span
                id="reward-amount-error"
                className={styles.validationMessage}
              >
                Enter a positive whole number of sats.
              </span>
            ) : null}
          </div>
        </div>
        {repoCount !== null ? (
          <p className={styles.sectionFact}>
            {`Automated rewards currently watch ${repoCount} connected ${
              repoCount === 1 ? 'repository' : 'repositories'
            }.`}
          </p>
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
