import React from 'react';
import { useState } from 'react';
import WalletYourWalletInfoCard from './components/WalletInfoCard';
import WalletTransactionHistory from './components/WalletTransactionHistory';
import WalletAllowanceCard from './components/WalletAllowanceComponent';
import styles from './Wallet.module.css';

const Wallet: React.FC = () => {
  const [showYourWalletTab, setshowYourWalletTab] = useState(true);
  const [activeWalletTabName, setActiveWalletTabName] =
    useState<string>('Private');

  const handleYourWalletTab = () => {
    setshowYourWalletTab(true);
    setActiveWalletTabName('Private');
  };

  const handleAllowanceTab = () => {
    setshowYourWalletTab(false);
    setActiveWalletTabName('Allowance');
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
          <WalletTransactionHistory activeMainTab={activeWalletTabName} />
        </div>
      ) : (
        <div>
          <WalletAllowanceCard />
          <WalletTransactionHistory activeMainTab={activeWalletTabName} />
        </div>
      )}
    </div>
  );
};

export default Wallet;
