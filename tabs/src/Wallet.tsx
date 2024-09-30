import React from 'react';
import { useState } from 'react';
import WalletYourWalletInfoCard from './components/WalletInfoCard';
import WalletTransactionHistory from './components/WalletTransactionHistory';
import WalletAllowanceCard from './components/WalletAllowanceComponent';
import styles from './Wallet.module.css';

const Wallet: React.FC = () => {
  const [timestamp, setTimestamp] = useState(
    Math.floor(Date.now() / 1000 - 7 * 24 * 60 * 60),
  );
  const [activePeriod, setActivePeriod] = useState(7); // Set default to 7-days
  const [showYourWalletTab, setshowYourWalletTab] = useState(true);
  const [activeWalletTabName, setActiveWalletTabName] = useState<string>('Private');

  const handleYourWalletTab = () => {
    setshowYourWalletTab(true);
    setActiveWalletTabName('Private');
  };

  const handleAllowanceTab = () => {
    setshowYourWalletTab(false);
    setActiveWalletTabName('Allowance');
  };

  const handlePeriodClick = (days: number) => {
    setTimestamp(Math.floor(Date.now() / 1000 - days * 24 * 60 * 60));
    setActivePeriod(days);
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
          <WalletTransactionHistory activeMainTab = {activeWalletTabName}  />
        </div>
      ) : (
        <div>
          <WalletAllowanceCard />
          <WalletTransactionHistory activeMainTab = {activeWalletTabName} />
        </div>
      )}
    </div>
  );
};

export default Wallet;
