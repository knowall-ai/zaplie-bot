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
      <div className={styles.tabs}>
        <div className={styles.tab}>
          <div className={styles.base}>
            <div className={styles.stringBadgeIconStack}>
              <div
                className={`${styles.stringTabTitle} ${
                  showYourWalletTab ? styles.active : ''
                }`}
                onClick={handleYourWalletTab}
              >
                Your wallet
              </div>
            </div>
          </div>
        </div>
        <div className={styles.tab1}>
          <div className={styles.base1}>
            <div className={styles.stringBadgeIconStack}>
              <div
                className={`${styles.stringTabTitle} ${
                  !showYourWalletTab ? styles.active : ''
                }`}
                onClick={handleAllowanceTab}
              >
                Allowance
              </div>
            </div>
          </div>
        </div>
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
