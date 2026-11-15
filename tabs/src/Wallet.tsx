import React, { useState } from 'react';
import ReceiveTargetCard from './components/ReceiveTargetCard';
import WalletTransactionHistory from './components/WalletTransactionHistory';
import WalletAllowanceCard from './components/WalletAllowanceComponent';
import styles from './Wallet.module.css';

const Wallet: React.FC = () => {
  const [activeWallet, setActiveWallet] = useState<WalletType>('Private');
  const showYourWalletTab = activeWallet === 'Private';

  const handleYourWalletTab = () => {
    setActiveWallet('Private');
  };

  const handleAllowanceTab = () => {
    setActiveWallet('Allowance');
  };

  return (
    <div className={styles.feedcomponent}>
      <div className={styles.tabs} aria-label="Wallet views">
        <button
          type="button"
          className={`${styles.stringTabTitle} ${
            showYourWalletTab ? styles.active : ''
          }`}
          onClick={handleYourWalletTab}
          aria-pressed={showYourWalletTab}
        >
          Your wallet
        </button>
        <button
          type="button"
          className={`${styles.stringTabTitle} ${
            !showYourWalletTab ? styles.active : ''
          }`}
          onClick={handleAllowanceTab}
          aria-pressed={!showYourWalletTab}
        >
          Allowance
        </button>
      </div>
      {showYourWalletTab ? (
        // The Private wallet is the person's own LNbits wallet: Zaplie can
        // invoice into it but never spend from or list it, so its history
        // lives in that wallet, not here.
        <div>
          <ReceiveTargetCard />
        </div>
      ) : (
        <div>
          <WalletAllowanceCard />
          <WalletTransactionHistory activeMainTab={activeWallet} />
        </div>
      )}
    </div>
  );
};

export default Wallet;
