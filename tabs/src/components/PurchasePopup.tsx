import React, { useEffect, useContext } from 'react';
import styles from './PurchasePopup.module.css';

import { RewardNameContext } from './RewardNameContext';

interface PurchasePopupProps {
  onClose: () => void;
  wallet: Wallet;
  hasEnoughSats: boolean;
  reward: Reward;
}

const PurchasePopup: React.FC<PurchasePopupProps> = ({
  onClose,
  wallet,
  hasEnoughSats,
  reward,
}) => {
  const storeOwnerEmail = process.env.REACT_APP_LNBITS_STORE_OWNER_EMAIL;
  console.log('Store Owner Email:', storeOwnerEmail);

  const handleOverlayClick = () => {
    onClose();
  };

  const handlePopupClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const handleConfirmClick = () => {
    if (storeOwnerEmail) {
      const subject = encodeURIComponent(
        `REWARD PURCHASE REQUEST: ${reward.name}`,
      );
      window.location.href = `mailto:${storeOwnerEmail}?subject=${subject}`;
    } else {
      console.error('Store owner email is not defined.');
    }
    onClose();
  };

  const rewardNameContext = useContext(RewardNameContext);
  const rewardsName = rewardNameContext?.rewardName || '';

  // Log wallet ID and balance to the console
  useEffect(() => {
    console.log('Wallet ID:', wallet.id);
    console.log('Balance:', wallet.balance_msat / 1000, rewardsName);
  }, [wallet, rewardsName]);

  if (!rewardNameContext) {
    return null; // or handle the case where the context is not available
  }

const message = hasEnoughSats
? `Please confirm you would like to purchase this reward.`
: `D'oh! You do not have enough ${rewardsName} to redeem this reward yet.`;

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.popup} onClick={handlePopupClick}>
        <p className={styles.title}>
          {hasEnoughSats ? 'Confirmation' : 'Oops!'}
        </p>
        <p className={styles.message}>{message}</p>{' '}
        {/* Display the message based on the boolean value */}
        <div className={styles.buttonContainer}>
          <button className={styles.closeButton} onClick={onClose}>
            {hasEnoughSats ? 'Cancel' : 'Close'}
          </button>
          {hasEnoughSats && (
            <button onClick={handleConfirmClick} className={styles.buyButton}>
              Confirm
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PurchasePopup;
