import React, { useCallback, useState } from 'react';
import styles from './WalletTransactionHistory.module.css';
import WalletTransactionLog from './WalletTransactionLog';

const WalletTransactionHistory: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>('all');

  const onHistoryTabClick = (tabName: string) => {
    setActiveTab(tabName);
  };

  const filterZaps = (currentActiveTab: string) => {
    // Define filterZaps function here or import it from WalletTransactionLog
    console.log(`Filtering zaps for tab: ${currentActiveTab}`);
  };

  return (
    <div className={styles.feedcomponent}>
      <div className={styles.tabs}>
        <div className={styles.tab} onClick={() => onHistoryTabClick('all')}>
          <div className={styles.base}>
            <div className={styles.stringBadgeIconStack}>
              <div className={styles.stringTabTitle}>All</div>
            </div>
            <div className={styles.borderPaddingStack}>
              {activeTab === 'all' && <div className={styles.borderBottom} />}
            </div>
          </div>
        </div>
        <div className={styles.tab1} onClick={() => onHistoryTabClick('sent')}>
          <div className={styles.base}>
            <div className={styles.stringBadgeIconStack}>
              <div className={styles.stringTabTitle}>Sent</div>
            </div>
            <div className={styles.borderPaddingStack}>
              {activeTab === 'sent' && <div className={styles.borderBottom} />}
            </div>
          </div>
        </div>

        <div
          className={styles.tab1}
          onClick={() => onHistoryTabClick('received')}
        >
          <div className={styles.base}>
            <div className={styles.stringBadgeIconStack}>
              <div className={styles.stringTabTitle}>Received</div>
            </div>
            <div className={styles.borderPaddingStack}>
              {activeTab === 'received' && (
                <div className={styles.borderBottom} />
              )}
            </div>
          </div>
        </div>
      </div>
      <WalletTransactionLog
        filterZaps={onHistoryTabClick}
        activeTab={activeTab}
      />
    </div>
  );
};

export default WalletTransactionHistory;
