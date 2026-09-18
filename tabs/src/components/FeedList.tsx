import React, { useEffect, useMemo, useState } from 'react';
import styles from './FeedList.module.css';
import ZapIcon from '../images/ZapIcon.svg';
import AscendingIcon from '../images/ascending.svg';
import DescendingIcon from '../images/descending.svg';
import { ZapTransfer } from '../utils/walletUtilities';

interface FeedListProps {
  timestamp: number;
  transfers: ZapTransfer[];
  loading: boolean;
  error: string | null;
}

type SortField = 'time' | 'from' | 'to' | 'amount';
type SortOrder = 'asc' | 'desc';

const ITEMS_PER_PAGE = 10;
const MAX_RECORDS = 100;

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

const person = (label: string, user: User | null) => (
  <span className={styles.person}>
    {user?.profileImg ? (
      <img className={styles.avatar} src={user.profileImg} alt="" />
    ) : (
      <span className={styles.avatarFallback} aria-hidden="true">
        {initialsOf(label)}
      </span>
    )}
    <span className={styles.personName}>{label}</span>
  </span>
);

const FeedList: React.FC<FeedListProps> = ({
  timestamp,
  transfers,
  loading,
  error,
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [sortField, setSortField] = useState<SortField>('time');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  useEffect(() => setCurrentPage(1), [sortField, sortOrder, timestamp]);

  const rows = useMemo(() => {
    const filtered = transfers.filter(
      transfer => timeInSeconds(transfer.transaction) >= timestamp,
    );
    return [...filtered]
      .sort((left, right) => {
        const values: Record<SortField, [number | string, number | string]> = {
          time: [
            timeInSeconds(left.transaction),
            timeInSeconds(right.transaction),
          ],
          from: [left.from.displayName, right.from.displayName],
          to: [left.to.displayName, right.to.displayName],
          // Transfers are outgoing payments (negative msats); sort on the
          // absolute value so the order matches the amount shown.
          amount: [
            Math.abs(left.transaction.amount),
            Math.abs(right.transaction.amount),
          ],
        };
        const [a, b] = values[sortField];
        const result =
          typeof a === 'number' && typeof b === 'number'
            ? a - b
            : String(a).localeCompare(String(b));
        return sortOrder === 'asc' ? result : -result;
      })
      .slice(0, MAX_RECORDS);
  }, [sortField, sortOrder, timestamp, transfers]);

  const totalPages = Math.max(1, Math.ceil(rows.length / ITEMS_PER_PAGE));
  const pageRows = rows.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE,
  );

  const sort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(current => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder(field === 'time' || field === 'amount' ? 'desc' : 'asc');
    }
  };

  const sortIcon = (field: SortField) =>
    sortField === field ? (
      <img
        src={sortOrder === 'asc' ? AscendingIcon : DescendingIcon}
        className={styles.sortArrow}
        alt=""
      />
    ) : null;

  if (loading) {
    return (
      <div className={styles.feedlist} aria-busy="true">
        <span className={styles.srOnly} role="status">
          Loading the zap feed
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
      <div className={`${styles.gridRow} ${styles.headRow}`} role="row">
        {(
          [
            ['time', 'Time', styles.cellTime],
            ['from', 'From', styles.cellFrom],
            ['to', 'To', styles.cellTo],
          ] as const
        ).map(([field, label, className]) => (
          <button
            key={field}
            type="button"
            className={`${styles.headCell} ${className}`}
            onClick={() => sort(field)}
          >
            {label} {sortIcon(field)}
          </button>
        ))}
        <span className={`${styles.headLabel} ${styles.cellMemo}`}>Reason</span>
        <button
          type="button"
          className={`${styles.headCell} ${styles.cellAmount} ${styles.amountHead}`}
          onClick={() => sort('amount')}
        >
          Zap amount {sortIcon('amount')}
        </button>
      </div>
      {pageRows.length ? (
        pageRows.map(({ transaction, from, to }) => {
          const anonymous = transaction.memo?.startsWith('[Anonymous]');
          const date = new Date(timeInSeconds(transaction) * 1000);
          return (
            <div
              key={transaction.checking_id}
              className={`${styles.gridRow} ${styles.bodyRow}`}
            >
              <time
                className={`${styles.timeCell} ${styles.cellTime}`}
                dateTime={date.toISOString()}
              >
                {date.toLocaleDateString('en-GB')}{' '}
                {date.toLocaleTimeString('en-GB', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </time>
              <span className={styles.cellFrom}>
                {person(
                  anonymous ? 'Anonymous' : from.displayName,
                  anonymous ? null : from,
                )}
              </span>
              <span className={styles.cellTo}>
                {person(to.displayName, to)}
              </span>
              <span className={`${styles.memoCell} ${styles.cellMemo}`}>
                {transaction.memo?.replace(/^\[Anonymous\]\s*/, '') ||
                  'No note'}
              </span>
              <span className={`${styles.amountCell} ${styles.cellAmount}`}>
                <b className={styles.amountValue}>
                  {Math.floor(
                    Math.abs(transaction.amount) / 1000,
                  ).toLocaleString()}
                </b>
                <img className={styles.zapIcon} alt="" src={ZapIcon} />
              </span>
            </div>
          );
        })
      ) : (
        <p className={styles.empty}>
          No zaps in this period yet. Recognise a teammate to get the feed
          going.
        </p>
      )}
      {rows.length > ITEMS_PER_PAGE && (
        <nav className={styles.pagination} aria-label="Feed pages">
          <button
            onClick={() => setCurrentPage(1)}
            disabled={currentPage === 1}
          >
            First
          </button>
          <button
            onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
            disabled={currentPage === 1}
          >
            Previous
          </button>
          <span>
            {currentPage} / {totalPages}
          </span>
          <button
            onClick={() =>
              setCurrentPage(page => Math.min(totalPages, page + 1))
            }
            disabled={currentPage === totalPages}
          >
            Next
          </button>
          <button
            onClick={() => setCurrentPage(totalPages)}
            disabled={currentPage === totalPages}
          >
            Last
          </button>
        </nav>
      )}
    </div>
  );
};

export default FeedList;
