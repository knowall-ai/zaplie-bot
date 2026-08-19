import React, {
  FunctionComponent,
  useState,
  useEffect,
  useContext,
} from 'react';
import styles from './setting.module.css';
import { updateRewardName } from '../apiService';
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { RewardNameContext } from './RewardNameContext';
import { useMsal } from '@azure/msal-react';
import { acquireIdToken, isZaplieAdmin } from '../services/adminRole';

const RewardsNameSetting: FunctionComponent = () => {
  const [isEditing, setIsEditing] = useState(false);
  const [currency, setCurrency] = useState('');
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const {
    rewardName,
    setRewardName,
    isLoading = false,
    error: loadError = null,
    retry,
  } = useContext(RewardNameContext);
  const { instance, accounts } = useMsal();
  const isAdmin = isZaplieAdmin(accounts[0]);

  useEffect(() => {
    if (rewardName !== null) {
      setCurrency(rewardName);
    }
  }, [rewardName]);

  const handleEditClick = () => {
    setJustSaved(false);
    setSaveError(null);
    setIsEditing(true);
  };

  const handleSaveClick = async () => {
    const normalizedRewardName = currency.trim();
    if (!normalizedRewardName) {
      setSaveError('Enter a reward name before saving.');
      return;
    }

    setSaving(true);
    setSaveError(null);
    setJustSaved(false);
    try {
      const account = accounts[0];
      if (!account) {
        throw new Error('You need to be signed in to change the reward name.');
      }
      const data = await updateRewardName(
        await acquireIdToken(instance, account),
        normalizedRewardName,
      );
      setCurrency(data.rewardName);
      setRewardName(data.rewardName);
      setIsEditing(false);
      setJustSaved(true);
      toast.success('Reward name has been updated successfully!');
    } catch {
      setSaveError("We couldn't save the reward name. Try again.");
      toast.error('Error updating reward name.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="rewards-heading">
      <div className={styles.sectionHeader}>
        <h2 id="rewards-heading" className={styles.heading}>
          Rewards
        </h2>
        <p className={styles.intro}>
          Choose what reward points are called across Zaplie.
        </p>
      </div>

      <div className={styles.card} aria-busy={isLoading || saving}>
        <label className={styles.fieldLabel} htmlFor="reward-name-input">
          Reward name
        </label>

        {isLoading && rewardName === null ? (
          <>
            <span className={styles.inputSkeleton} aria-hidden="true" />
            <span className={styles.visuallyHidden} role="status">
              Loading reward name…
            </span>
          </>
        ) : rewardName !== null ? (
          <div className={styles.inputRow}>
            <input
              id="reward-name-input"
              type="text"
              value={currency}
              onChange={event => {
                setCurrency(event.target.value);
                setSaveError(null);
                setJustSaved(false);
              }}
              disabled={!isEditing || saving}
              className={`${styles.textBox} ${isEditing ? styles.editing : ''}`}
              title="Reward name"
              placeholder="Enter reward name"
              aria-invalid={saveError ? 'true' : undefined}
            />
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
        ) : null}

        {loadError ? (
          <>
            <p className={styles.errorText} role="alert">
              We couldn't load the current reward name.
            </p>
            {retry ? (
              <button
                type="button"
                onClick={retry}
                className={styles.secondaryButton}
                disabled={isLoading}
              >
                Try again
              </button>
            ) : null}
          </>
        ) : null}

        {saveError ? (
          <p className={styles.errorText} role="alert">
            {saveError}
          </p>
        ) : null}

        {justSaved && !isEditing && !saving ? (
          <p className={styles.successText} role="status">
            Reward name saved.
          </p>
        ) : null}

        {!isAdmin && !isLoading && rewardName !== null ? (
          <p className={styles.helperText}>
            Only Zaplie admins can change the reward name.
          </p>
        ) : null}
      </div>
    </section>
  );
};

export default RewardsNameSetting;
