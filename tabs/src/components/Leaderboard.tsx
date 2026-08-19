import React, { useMemo, useState } from 'react';
import styles from './Leaderboard.module.css';
import ZapIcon from '../images/ZapIcon.svg';
import AscendingIcon from '../images/ascending.svg';
import DescendingIcon from '../images/descending.svg';
import { ZapTransfer } from '../utils/walletUtilities';

interface LeaderboardProps {
  timestamp: number;
  transfers: ZapTransfer[];
  loading: boolean;
  error: string | null;
}

interface UserTransactionSummary {
  user: User;
  totalAmountSats: number;
  rank: number;
}

const timeInSeconds = (transaction: Transaction): number => {
  const value =
    typeof transaction.time === 'number'
      ? transaction.time
      : Date.parse(transaction.time) / 1000;
  return Number.isFinite(value) ? value : 0;
};

const initialsOf = (label: string): string => {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return label.trim().slice(0, 2).toUpperCase();
};

const Leaderboard: React.FC<LeaderboardProps> = ({
  timestamp,
  transfers,
  loading,
  error,
}) => {
  const [ascending, setAscending] = useState(false);
  const summaries = useMemo(() => {
    const totals = new Map<string, { user: User; total: number }>();
    transfers
      .filter(transfer => timeInSeconds(transfer.transaction) >= timestamp)
      .forEach(({ to, transaction }) => {
        const current = totals.get(to.id) ?? { user: to, total: 0 };
        current.total += Math.abs(transaction.amount) / 1000;
        totals.set(to.id, current);
      });

    const ranked: UserTransactionSummary[] = Array.from(totals.values())
      .sort((left, right) => right.total - left.total)
      .map((item, index) => ({
        user: item.user,
        totalAmountSats: Math.floor(item.total),
        rank: index + 1,
      }));
    return ascending ? [...ranked].reverse() : ranked;
  }, [ascending, timestamp, transfers]);

  if (loading) {
    return (
      <div className={styles.feedlist} aria-busy="true">
        <span className={styles.srOnly} role="status">
          Loading the leaderboard
        </span>
        <div className={styles.skeletonList} aria-hidden="true">
          {[0, 1, 2, 3, 4].map(item => (
            <div key={item} className={styles.skeletonRow} />
          ))}
        </div>
      </div>
    );
  }

  if (error)
    return (
      <div className={styles.errorBox} role="alert">
        {error}
      </div>
    );

  return (
    <div className={styles.feedlist}>
      <div className={styles.headRow}>
        <span className={`${styles.headLabel} ${styles.rankCol}`}>Rank</span>
        <span className={`${styles.headLabel} ${styles.userCol}`}>User</span>
        <button
          type="button"
          className={`${styles.headSortButton} ${styles.amountCol}`}
          aria-label={`Zap amount, sorted ${ascending ? 'ascending' : 'descending'}`}
          onClick={() => setAscending(current => !current)}
        >
          Zap amount
          <img
            src={ascending ? AscendingIcon : DescendingIcon}
            alt=""
            className={styles.sortIcon}
          />
        </button>
      </div>
      {summaries.length ? (
        <ol className={styles.ranking}>
          {summaries.map(summary => (
            <li key={summary.user.id} className={styles.bodyRow}>
              <span className={styles.rankCol}>
                <span
                  className={
                    summary.rank <= 3
                      ? `${styles.rankBadge} ${styles.rankBadgeTop}`
                      : styles.rankBadge
                  }
                >
                  {summary.rank}
                </span>
              </span>
              <span className={`${styles.person} ${styles.userCol}`}>
                {summary.user.profileImg ? (
                  <img
                    className={styles.avatar}
                    src={summary.user.profileImg}
                    alt=""
                  />
                ) : (
                  <span className={styles.avatarFallback} aria-hidden="true">
                    {initialsOf(summary.user.displayName)}
                  </span>
                )}
                <span className={styles.personName}>
                  {summary.user.displayName}
                </span>
              </span>
              <span className={`${styles.amountCell} ${styles.amountCol}`}>
                <b className={styles.amountValue}>
                  {new Intl.NumberFormat('en-US').format(
                    summary.totalAmountSats,
                  )}
                </b>
                <img className={styles.zapIcon} alt="" src={ZapIcon} />
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.empty}>
          No zaps in this period yet, so there are no leaders to show.
        </p>
      )}
    </div>
  );
};

export default Leaderboard;
