import React, { useState } from 'react';
import WalletYourWalletInfoCard from './components/WalletInfoCard';
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
        <div>
          <WalletYourWalletInfoCard />
          <WalletTransactionHistory activeMainTab={activeWallet} />
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
