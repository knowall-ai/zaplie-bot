import React, { useContext, useState } from 'react';
import styles from './PurchasePopup.module.css';
import { RewardNameContext } from './RewardNameContext';

interface PurchasePopupProps {
  onClose: () => void;
  hasEnoughSats: boolean;
  reward: Reward;
}

const PurchasePopup: React.FC<PurchasePopupProps> = ({
  onClose,
  hasEnoughSats,
  reward,
}) => {
  const { rewardName } = useContext(RewardNameContext);
  const [error, setError] = useState<string | null>(null);
  const storeOwnerEmail =
    process.env.REACT_APP_LNBITS_STORE_OWNER_EMAIL?.trim();

  const requestReward = () => {
    if (!rewardName) {
      setError('The reward name is unavailable. Try again later.');
      return;
    }

    if (!storeOwnerEmail) {
      setError('Reward requests are not configured for this environment.');
      return;
    }

    const subject = encodeURIComponent(`REWARD REQUEST: ${reward.name}`);
    const body = encodeURIComponent(
      `I would like to request ${reward.name} (${reward.price} ${rewardName}).`,
    );
    window.location.assign(
      `mailto:${storeOwnerEmail}?subject=${subject}&body=${body}`,
    );
  };

  return (
    <div
      className={styles.overlay}
      onClick={event => event.target === event.currentTarget && onClose()}
    >
      <div className={styles.popup} role="dialog" aria-modal="true">
        <h2 className={styles.title}>
          {hasEnoughSats ? 'Request reward' : 'Not enough balance'}
        </h2>
        <p className={styles.message}>
          {hasEnoughSats
            ? 'This sends a request to the rewards administrator. Your balance is not charged by this action.'
            : 'You do not have enough balance to request this reward.'}
        </p>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.buttonContainer}>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
          >
            {hasEnoughSats ? 'Cancel' : 'Close'}
          </button>
          {hasEnoughSats && (
            <button
              type="button"
              onClick={requestReward}
              className={styles.buyButton}
            >
              Email request
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PurchasePopup;
