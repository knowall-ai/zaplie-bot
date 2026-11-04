import React, { useContext, useMemo } from 'react';
import { useMsal } from '@azure/msal-react';
import { useQuery } from '@tanstack/react-query';
import ArrowIncoming from '../images/ArrowIncoming.svg';
import ArrowOutgoing from '../images/ArrowOutcoming.svg';
import { getWalletTransactionsSince } from '../services/lnbits/payments';
import { getUsers } from '../services/lnbits/users';
import { getUserWallets } from '../services/lnbits/wallets';
import {
  pairId,
  transactionTime,
  ZapActivity,
  ZapTransfer,
  zapActivityQueryOptions,
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

const TRANSACTION_HISTORY_DAYS = 30;
const SECONDS_PER_DAY = 86_400;

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
  const activityQuery = useQuery({
    ...zapActivityQueryOptions(TRANSACTION_HISTORY_DAYS),
    enabled: Boolean(accountId),
  });
  const historyQuery = useQuery({
    queryKey: ['walletHistory', accountId, activeWallet, TRANSACTION_HISTORY_DAYS],
    enabled: Boolean(accountId),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<WalletHistory> => {
      if (!accountId) {
        throw new Error('Your Zaplie account could not be identified.');
      }
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

      const since =
        Date.now() / 1000 - TRANSACTION_HISTORY_DAYS * 86_400;
      const transactions = await getWalletTransactionsSince(
        matchingWallets[0].id,
        since,
        null,
      );
      return { currentUser, transactions };
    },
  });

  const history = historyQuery.data ?? null;
  const activity: ZapActivity | null = activityQuery.data ?? null;
  const loading = historyQuery.isPending || activityQuery.isPending;
  const error = historyQuery.error ?? activityQuery.error;
  const retry = () => {
    void Promise.all([historyQuery.refetch(), activityQuery.refetch()]);
  };

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

  if (!accountId) {
    return (
      <div className={styles.errorState} role="alert">
        {accountCount === 0
          ? 'Sign in to load your transaction history.'
          : 'Your Zaplie account could not be identified.'}
      </div>
    );
  }

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
        <span>{error.message}</span>
        <button type="button" onClick={retry}>
          Try again
        </button>
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
                  aria-hidden="true"
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
        <div className={styles.emptyState} role="status">
          No transactions to show.
        </div>
      )}
    </div>
  );
};

export default WalletTransactionLog;
