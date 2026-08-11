import React, { FunctionComponent, useState, useEffect } from 'react';
import styles from './setting.module.css';
import { getRewardAmounts, updateRewardAmounts } from '../apiService';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

const REWARD_LABELS: Record<string, string> = {
  githubPrMergedSats: 'GitHub PR Merged (sats)',
};

const RewardAmountsSetting: FunctionComponent = () => {
  const [isEditing, setIsEditing] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const fetchRewardAmounts = async () => {
      try {
        const data = await getRewardAmounts();
        setAmounts(data.rewardAmounts);
      } catch (error) {
        console.error('Error fetching reward amounts:', error);
        toast.error('Error fetching reward amounts.');
      }
    };

    fetchRewardAmounts();
  }, []);

  const handleEditClick = () => {
    setIsEditing(true);
  };

  const handleAmountChange = (key: string, value: string) => {
    setAmounts((prev) => ({ ...prev, [key]: Number(value) }));
  };

  const handleSaveClick = async () => {
    setIsEditing(false);
    try {
      const data = await updateRewardAmounts(amounts);
      setAmounts(data.rewardAmounts);
      toast.success('Reward amounts have been updated successfully!');
    } catch (error) {
      console.error('Error updating reward amounts:', error);
      toast.error('Error updating reward amounts.');
    }
  };

  return (
    <div className={styles.currencySetting}>
      <label className={styles.label}>Automation Reward Amounts</label>
      {Object.keys(amounts).map((key) => (
        <div className={styles.inputGroup} key={key}>
          <label className={styles.label}>{REWARD_LABELS[key] || key}</label>
          <input
            type="number"
            value={amounts[key]}
            onChange={(e) => handleAmountChange(key, e.target.value)}
            disabled={!isEditing}
            className={`${styles.textBox} ${styles.compactInput} ${isEditing ? styles.editing : ''}`}
            title={REWARD_LABELS[key] || key}
          />
        </div>
      ))}
      {!isEditing ? (
        <button onClick={handleEditClick} className={styles.editButton}>
          Edit
        </button>
      ) : (
        <button onClick={handleSaveClick} className={styles.saveButton}>
          Save
        </button>
      )}
      <ToastContainer />
    </div>
  );
};

export default RewardAmountsSetting;
