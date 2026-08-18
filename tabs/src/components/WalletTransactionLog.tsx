import React, { useContext, useEffect, useMemo, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import ArrowIncoming from '../images/ArrowIncoming.svg';
import ArrowOutgoing from '../images/ArrowOutcoming.svg';
import {
  getUsers,
  getUserWallets,
  getWalletTransactionsSince,
} from '../services/lnbitsServiceLocal';
import {
  fetchZapActivity,
  pairId,
  transactionTime,
  ZapTransfer,
} from '../utils/walletUtilities';
import { RewardNameContext } from './RewardNameContext';
import styles from './WalletTransactionLog.module.css';

type HistoryFilter = 'all' | 'sent' | 'received';

interface WalletTransactionLogProps {
  activeTab: HistoryFilter;
  activeWallet: WalletType;
}

interface TransactionHistory {
  currentUser: User;
  transactions: Transaction[];
  transfersById: Map<string, ZapTransfer>;
}

const SECONDS_PER_DAY = 86_400;
const TRANSACTION_HISTORY_DAYS = 30;

const relativeTime = (transaction: Transaction): string => {
  const seconds = transactionTime(transaction);
  if (!Number.isFinite(seconds)) return 'Time unavailable';

  const elapsedSeconds = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (elapsedSeconds < 60) return `${elapsedSeconds} seconds ago`;
  if (elapsedSeconds < 3_600) {
    return `${Math.floor(elapsedSeconds / 60)} minutes ago`;
  }
  if (elapsedSeconds < SECONDS_PER_DAY) {
    return `${Math.floor(elapsedSeconds / 3_600)} hours ago`;
  }
  return `${Math.floor(elapsedSeconds / SECONDS_PER_DAY)} days ago`;
};

const counterpartyName = (
  transaction: Transaction,
  currentUser: User,
  transfer: ZapTransfer | undefined,
): string => {
  if (!transfer) return 'Counterparty unavailable';

  if (transaction.amount > 0) {
    if (transfer.to.id !== currentUser.id) return 'Counterparty unavailable';
    if (transaction.memo?.startsWith('[Anonymous]')) return 'Anonymous';
    return (
      transfer.from.displayName ||
      transfer.from.email ||
      'Counterparty unavailable'
    );
  }

  if (transaction.amount < 0) {
    if (transfer.from.id !== currentUser.id) {
      return 'Counterparty unavailable';
    }
    return (
      transfer.to.displayName || transfer.to.email || 'Counterparty unavailable'
    );
  }

  return 'Counterparty unavailable';
};

const WalletTransactionLog: React.FC<WalletTransactionLogProps> = ({
  activeTab,
  activeWallet,
}) => {
  const { accounts } = useMsal();
  const accountCount = accounts.length;
  const accountId =
    accountCount === 1 ? accounts[0]?.localAccountId : undefined;
  const {
    rewardName,
    isLoading: isRewardNameLoading,
    error: rewardNameError,
    retry: retryRewardName,
  } = useContext(RewardNameContext);
  const [history, setHistory] = useState<TransactionHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const loadTransactions = async () => {
      setHistory(null);
      setError(null);

      if (!accountId) {
        setLoading(false);
        setError(
          accountCount === 0
            ? 'Sign in to load your transaction history.'
            : 'Your Zaplie account could not be identified.',
        );
        return;
      }

      setLoading(true);
      try {
        const matchingUsers = await getUsers({ aadObjectId: accountId });
        if (matchingUsers.length !== 1) {
          throw new Error('Your Zaplie account could not be identified.');
        }

        const currentUser = matchingUsers[0];
        const wallets = await getUserWallets(currentUser.id);
        const matchingWallets = wallets.filter(
          candidate =>
            candidate.name.trim().toLowerCase() === activeWallet.toLowerCase(),
        );
        if (matchingWallets.length === 0) {
          throw new Error(`Your ${activeWallet} wallet could not be found.`);
        }
        if (matchingWallets.length > 1) {
          throw new Error(
            `Your ${activeWallet} wallet could not be identified uniquely.`,
          );
        }
        const wallet = matchingWallets[0];

        const since =
          Date.now() / 1000 - TRANSACTION_HISTORY_DAYS * SECONDS_PER_DAY;
        const [transactions, activity] = await Promise.all([
          getWalletTransactionsSince(wallet.id, since, null),
          fetchZapActivity(),
        ]);
        const transfersById = new Map(
          activity.transfers
            .map(transfer => [pairId(transfer.transaction), transfer] as const)
            .filter(([id]) => Boolean(id)),
        );

        if (!cancelled) {
          setHistory({ currentUser, transactions, transfersById });
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Transaction history could not be loaded.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadTransactions();
    return () => {
      cancelled = true;
    };
  }, [accountCount, accountId, activeWallet, retryToken]);

  const displayedTransactions = useMemo(() => {
    if (!history) return [];

    return history.transactions
      .filter(transaction => {
        if (activeTab === 'sent') return transaction.amount < 0;
        if (activeTab === 'received') return transaction.amount > 0;
        return true;
      })
      .slice()
      .sort((left, right) => transactionTime(right) - transactionTime(left));
  }, [activeTab, history]);

  if (loading) {
    return (
      <div className={styles.feedlist} aria-busy="true" role="status">
        <span className={styles.srOnly}>Loading transactions</span>
        {[0, 1, 2].map(placeholder => (
          <div
            key={placeholder}
            className={styles.skeletonRow}
            aria-hidden="true"
          >
            <div className={styles.skeletonAvatar} />
            <div className={styles.skeletonLines}>
              <div
                className={`${styles.skeletonLine} ${styles.skeletonLineNarrow}`}
              />
              <div
                className={`${styles.skeletonLine} ${styles.skeletonLineWide}`}
              />
            </div>
            <div className={styles.skeletonAmount} />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.errorState} role="alert">
        <span>{error}</span>
        {accountId && (
          <button
            type="button"
            onClick={() => setRetryToken(token => token + 1)}
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  if (isRewardNameLoading) {
    return (
      <div className={styles.statusState} aria-busy="true" role="status">
        Loading reward name…
      </div>
    );
  }

  if (rewardNameError || !rewardName) {
    return (
      <div className={styles.errorState} role="alert">
        <span>
          {rewardNameError?.message || 'The reward name is unavailable.'}
        </span>
        {retryRewardName && (
          <button type="button" onClick={retryRewardName}>
            Try again
          </button>
        )}
      </div>
    );
  }

  if (!history) return null;

  return (
    <div className={styles.feedlist}>
      {displayedTransactions.map((transaction, index) => {
        const outgoing = transaction.amount < 0;
        const transfer = history.transfersById.get(pairId(transaction));
        const counterparty = counterpartyName(
          transaction,
          history.currentUser,
          transfer,
        );
        const time = transactionTime(transaction);
        const memo = transaction.memo?.replace(/^\[Anonymous\]\s*/, '').trim();
        const amount = transaction.amount / 1000;

        return (
          <div
            key={transaction.checking_id || index}
            className={styles.bodycell}
          >
            <div className={styles.bodyContents}>
              <div className={styles.mainContentStack}>
                <img
                  className={styles.avatarIcon}
                  alt=""
                  src={outgoing ? ArrowOutgoing : ArrowIncoming}
                />
                <div className={styles.userName}>
                  <p className={styles.txTitle}>
                    <b>
                      {transaction.extra?.tag === 'zap' ? 'Zap' : 'Payment'}
                    </b>
                    {transaction.pending && (
                      <span className={styles.pending}>Pending</span>
                    )}
                  </p>
                  <p className={styles.txMeta}>
                    <time
                      dateTime={
                        Number.isFinite(time)
                          ? new Date(time * 1000).toISOString()
                          : undefined
                      }
                    >
                      {relativeTime(transaction)}
                    </time>
                    <span aria-hidden="true"> · </span>
                    {outgoing
                      ? 'to'
                      : transaction.amount > 0
                        ? 'from'
                        : 'with'}{' '}
                    <b>{counterparty}</b>
                  </p>
                  {memo && <p className={styles.txMemo}>{memo}</p>}
                </div>
              </div>
              <div
                className={`${styles.transactionDetailsAllowance} ${
                  outgoing ? styles.amountNegative : styles.amountPositive
                }`}
              >
                <b className={styles.b}>
                  {transaction.amount > 0 ? '+' : ''}
                  {amount.toLocaleString()}
                </b>{' '}
                {rewardName}
              </div>
            </div>
          </div>
        );
      })}
      {displayedTransactions.length === 0 && (
        <div className={styles.emptyState}>No transactions to show.</div>
      )}
    </div>
  );
};

export default WalletTransactionLog;
