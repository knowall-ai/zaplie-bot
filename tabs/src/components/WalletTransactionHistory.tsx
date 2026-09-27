import React, { useState } from 'react';
import styles from './WalletTransactionHistory.module.css';
import WalletTransactionLog from './WalletTransactionLog';

type HistoryFilter = 'all' | 'sent' | 'received';

interface WalletTransactionHistoryProps {
  activeMainTab?: string;
}

const FILTERS: Array<{ id: HistoryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'sent', label: 'Sent' },
  { id: 'received', label: 'Received' },
];

const WalletTransactionHistory: React.FC<WalletTransactionHistoryProps> = ({
  activeMainTab,
}) => {
  const [activeTab, setActiveTab] = useState<HistoryFilter>('all');

  if (activeMainTab !== 'Private' && activeMainTab !== 'Allowance') {
    return (
      <div className={styles.feedcomponent} role="alert">
        Choose a wallet to view its transaction history.
      </div>
    );
  }

  return (
    <div className={styles.feedcomponent}>
      <div className={styles.tabs} aria-label="Filter transactions">
        {FILTERS.map(filter => (
          <button
            key={filter.id}
            type="button"
            className={`${styles.stringTabTitle} ${
              activeTab === filter.id ? styles.active : ''
            }`}
            onClick={() => setActiveTab(filter.id)}
            aria-pressed={activeTab === filter.id}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <WalletTransactionLog
        activeTab={activeTab}
        activeWallet={activeMainTab}
      />
    </div>
  );
};

export default WalletTransactionHistory;
