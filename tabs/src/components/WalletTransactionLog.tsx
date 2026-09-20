import React, { useContext, useEffect, useMemo, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import ArrowIncoming from '../images/ArrowIncoming.svg';
import ArrowOutgoing from '../images/ArrowOutcoming.svg';
import { getWalletTransactionsSince } from '../services/lnbits/payments';
import { getUsers } from '../services/lnbits/users';
import { getUserWallets } from '../services/lnbits/wallets';
import {
  fetchZapActivity,
  pairId,
  transactionTime,
  ZapActivity,
  ZapTransfer,
} from '../utils/walletUtilities';
import { RewardNameContext } from './RewardNameContext';
import styles from './WalletTransactionLog.module.css';

type HistoryFilter = 'all' | 'sent' | 'received';

interface WalletTransactionLogProps {
  activeTab: HistoryFilter;
  activeWallet: WalletType;
}

interface WalletHistory {
  currentUser: User;
  transactions: Transaction[];
}

const SECONDS_PER_DAY = 86_400;
const TRANSACTION_HISTORY_DAYS = 30;

// Intl gets the singular forms right ("1 minute ago", not "1 minutes ago").
// The rest of this tab is English-only, so the locale is pinned to match
// rather than following the browser and leaving a half-translated row.
const relativeTimeFormat = new Intl.RelativeTimeFormat('en', {
  numeric: 'always',
});

const relativeTime = (transaction: Transaction): string => {
  const seconds = transactionTime(transaction);
  if (!Number.isFinite(seconds)) return 'Time unavailable';

  // Negated because these are all in the past; -0 still formats as "ago".
  const elapsedSeconds = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (elapsedSeconds < 60) {
    return relativeTimeFormat.format(-elapsedSeconds, 'second');
  }
  if (elapsedSeconds < 3_600) {
    return relativeTimeFormat.format(
      -Math.floor(elapsedSeconds / 60),
      'minute',
    );
  }
  if (elapsedSeconds < SECONDS_PER_DAY) {
    return relativeTimeFormat.format(
      -Math.floor(elapsedSeconds / 3_600),
      'hour',
    );
  }
  return relativeTimeFormat.format(
    -Math.floor(elapsedSeconds / SECONDS_PER_DAY),
    'day',
  );
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
  const [history, setHistory] = useState<WalletHistory | null>(null);
  const [activity, setActivity] = useState<ZapActivity | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const loading = loadingHistory || loadingActivity;
  const error = historyError ?? activityError;

  // The tenant-wide pairing data is the expensive half of this screen — every
  // user, every user's wallets, and paged instance-wide payments — and none of
  // it depends on which of the signed-in user's own wallets is on screen. It
  // gets its own effect so switching Private/Allowance does not re-run it.
  useEffect(() => {
    if (!accountId) {
      setActivity(null);
      setActivityError(null);
      setLoadingActivity(false);
      return;
    }

    let cancelled = false;
    setActivity(null);
    setActivityError(null);
    setLoadingActivity(true);

    const since =
      Date.now() / 1000 - TRANSACTION_HISTORY_DAYS * SECONDS_PER_DAY;

    fetchZapActivity(since)
      .then(loaded => {
        if (!cancelled) setActivity(loaded);
      })
      .catch(loadError => {
        if (!cancelled) {
          setActivityError(
            loadError instanceof Error
              ? loadError.message
              : 'Transaction history could not be loaded.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingActivity(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, retryToken]);

  // The selected wallet's own rows, which is the only part a wallet switch
  // actually invalidates.
  useEffect(() => {
    let cancelled = false;

    const loadTransactions = async () => {
      setHistory(null);
      setHistoryError(null);

      if (!accountId) {
        setLoadingHistory(false);
        setHistoryError(
          accountCount === 0
            ? 'Sign in to load your transaction history.'
            : 'Your Zaplie account could not be identified.',
        );
        return;
      }

      setLoadingHistory(true);
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
        const transactions = await getWalletTransactionsSince(
          wallet.id,
          since,
          null,
        );

        if (!cancelled) {
          setHistory({ currentUser, transactions });
        }
      } catch (loadError) {
        if (!cancelled) {
          setHistoryError(
            loadError instanceof Error
              ? loadError.message
              : 'Transaction history could not be loaded.',
          );
        }
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    };

    void loadTransactions();
    return () => {
      cancelled = true;
    };
  }, [accountCount, accountId, activeWallet, retryToken]);

  const transfersById = useMemo(() => {
    const byId = new Map<string, ZapTransfer>();
    activity?.transfers.forEach(transfer => {
      const id = pairId(transfer.transaction);
      if (id) byId.set(id, transfer);
    });
    return byId;
  }, [activity]);

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
      {activity?.truncated && (
        <div className={styles.truncatedNotice} role="status">
          History truncated: only the most recent payments could be read, so
          some counterparties are unavailable.
        </div>
      )}
      {displayedTransactions.map((transaction, index) => {
        const outgoing = transaction.amount < 0;
        const transfer = transfersById.get(pairId(transaction));
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
