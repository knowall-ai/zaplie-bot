// filepath: /c:/projects/ZapVibes/tabs/src/components/RewardsNameSetting.tsx
import React, { FunctionComponent, useState, useEffect, useContext } from 'react';
import styles from './setting.module.css';
import { getRewardName, updateRewardName } from '../apiService';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { RewardNameContext } from './RewardNameContext';

const CurrencySetting: FunctionComponent = () => {
  const [isEditing, setIsEditing] = useState(false);
  const [currency, setCurrency] = useState(''); // Default value
  const { setRewardName } = useContext(RewardNameContext);

  useEffect(() => {
    const fetchRewardName = async () => {
      try {
        const data = await getRewardName();
        setCurrency(data.rewardName);
      } catch (error) {
        console.error('Error fetching reward name:', error);
      }
    };

    fetchRewardName();
  }, []);

  const handleEditClick = () => {
    setIsEditing(true);
  };

  const handleSaveClick = async () => {
    setIsEditing(false);
    try {
      const data = await updateRewardName(currency);
      console.log('Reward name saved:', data.rewardName);
      setRewardName(data.rewardName); // Update the context
      toast.success('Reward name has been updated successfully!');
    } catch (error) {
      console.error('Error updating reward name:', error);
      toast.error('Error updating reward name.');
    }
  };

  return (
    <div className={styles.currencySetting}>
      <label className={styles.label}>Reward Name</label>
      <div className={styles.inputGroup}>
        <input
          type="text"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          disabled={!isEditing}
          className={`${styles.textBox} ${isEditing ? styles.editing : ''}`}
          title="Reward name"
          placeholder="Enter currency"
        />
        {!isEditing ? (
          <button onClick={handleEditClick} className={styles.editButton}>
            Edit
          </button>
        ) : (
          <button onClick={handleSaveClick} className={styles.saveButton}>
            Save
          </button>
        )}
      </div>
      <ToastContainer />
    </div>
  );
};

export default CurrencySetting;