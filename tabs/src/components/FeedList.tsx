import React, { useEffect, useMemo, useState } from 'react';
import styles from './FeedList.module.css';
import ZapIcon from '../images/ZapIcon.svg';
import { useQuery } from '@tanstack/react-query';
import { zapActivityQueryOptions } from '../utils/walletUtilities';

interface FeedListProps {
  timestamp?: number | null;
}

const ITEMS_PER_PAGE = 10; // Items per page

// Helper function to parse transaction timestamp (handles both Unix seconds and ISO strings)
const parseTransactionTime = (timestamp: number | string): Date | null => {
  if (typeof timestamp === 'number') {
    return new Date(timestamp * 1000);
  }
  if (typeof timestamp === 'string') {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      console.warn(`Invalid timestamp: ${timestamp}`);
      return null;
    }
    return date;
  }
  return null;
};

const FeedList: React.FC<FeedListProps> = ({ timestamp }) => {
  const [currentPage, setCurrentPage] = useState(1);
  const { data: activity, isPending, error, refetch } = useQuery(
    zapActivityQueryOptions(),
  );

  // State for sorting (excluding the Memo field)
  const [sortField, setSortField] = useState<'time' | 'from' | 'to' | 'amount'>(
    'time',
  );
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  useEffect(() => setCurrentPage(1), [timestamp]);

  const zaps = useMemo(
    () =>
      (activity?.transfers ?? []).map(({ from, to, transaction }) => ({
        from,
        to,
        transaction,
      })),
    [activity],
  );

  const handleSort = (field: 'time' | 'from' | 'to' | 'amount') => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const sortedZaps = useMemo(
    () =>
      [...zaps].sort((a, b) => {
        let valA: number | string;
        let valB: number | string;

        switch (sortField) {
          case 'time':
            valA = a.transaction.time;
            valB = b.transaction.time;
            break;
          case 'from':
            valA = a.from.displayName || '';
            valB = b.from.displayName || '';
            break;
          case 'to':
            valA = a.to.displayName || '';
            valB = b.to.displayName || '';
            break;
          case 'amount':
            valA = a.transaction.amount;
            valB = b.transaction.amount;
            break;
        }

        if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
        return 0;
      }),
    [sortField, sortOrder, zaps],
  );

  // Apply timestamp filter (7/30/60 days) - filter transactions by time
  // timestamp prop is in Unix seconds (e.g., 7 days ago)
  // transaction.time can be either a number (Unix seconds) or an ISO date string
  const filteredZaps =
    timestamp && timestamp > 0
      ? sortedZaps.filter(zap => {
          const parsedDate = parseTransactionTime(zap.transaction.time);
          if (!parsedDate) {
            return false; // Exclude transactions with invalid/unknown time format
          }
          const txTimeSeconds = Math.floor(parsedDate.getTime() / 1000);
          return txTimeSeconds >= timestamp;
        })
      : sortedZaps;

  // Calculate pagination variables
  const totalPages = Math.max(
    1,
    Math.ceil(filteredZaps.length / ITEMS_PER_PAGE),
  );
  const displayedPage = Math.min(currentPage, totalPages);
  const indexOfLastItem = displayedPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentItems = filteredZaps.slice(indexOfFirstItem, indexOfLastItem);

  const nextPage = () =>
    setCurrentPage(prev => Math.min(prev + 1, totalPages));
  const prevPage = () => setCurrentPage(prev => Math.max(prev - 1, 1));
  const firstPage = () => setCurrentPage(1);
  const lastPage = () => setCurrentPage(totalPages);

  if (isPending) {
    return (
      <div className={styles.loadingState} aria-busy="true" role="status">
        <span className={styles.srOnly}>Loading activity feed</span>
        {[0, 1, 2].map(placeholder => (
          <div
            key={placeholder}
            className={styles.skeletonRow}
            aria-hidden="true"
          >
            <div className={styles.skeletonBlock} />
            <div className={styles.skeletonBlock} />
          </div>
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className={styles.errorState} role="alert">
        <span>
          {error instanceof Error
            ? `Failed to load activity feed: ${error.message}`
            : 'Unable to load activity feed. Please refresh and try again.'}
        </span>
        <button type="button" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <div className={styles.feedlist}>
      {activity?.truncated && (
        <div className={styles.truncatedNotice} role="status">
          History truncated: only the most recent payments could be read.
        </div>
      )}
      <div className={styles.headercell}>
        <div className={styles.headerContents}>
          {/* Interactive sortable headers with hover effect */}
          <b
            className={`${styles.string} ${styles.hoverable}`}
            onClick={() => handleSort('time')}
          >
            Time {sortField === 'time' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
          </b>
          <b
            className={`${styles.string} ${styles.hoverable}`}
            onClick={() => handleSort('from')}
          >
            From {sortField === 'from' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
          </b>
          <b
            className={`${styles.string} ${styles.hoverable}`}
            onClick={() => handleSort('to')}
          >
            To {sortField === 'to' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
          </b>
          {/* Memo header without sorting/hover effect */}
          <b className={styles.string2}>Memo</b>
          <div
            className={`${styles.stringWrapper} ${styles.hoverable}`}
            onClick={() => handleSort('amount')}
          >
            <b className={styles.string3}>
              Amount{' '}
              {sortField === 'amount' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
            </b>
          </div>
        </div>
      </div>
      {currentItems.length > 0 ? (
        currentItems.map((zap, index) => (
          <div
            key={zap.transaction.checking_id || index}
            className={styles.bodycell}
          >
            <div className={styles.bodyContents}>
              <div className={styles.mainContentStack}>
                <div className={styles.personDetails}>
                  <div className={styles.userName}>
                    {(() => {
                      const date = parseTransactionTime(zap.transaction.time);
                      if (!date) {
                        return `Invalid: ${zap.transaction.time}`;
                      }
                      // UK format: DD/MM/YYYY HH:MM (24-hour)
                      return `${date.toLocaleDateString('en-GB')} ${date.toLocaleTimeString(
                        'en-GB',
                        {
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        },
                      )}`;
                    })()}
                  </div>
                </div>
                <div className={styles.personDetails}>
                  <img
                    className={styles.avatarIcon}
                    alt=""
                    src="avatar.png"
                    style={{ display: 'none' }}
                  />
                  <div className={styles.userName}>
                    {zap.transaction.memo?.startsWith('[Anonymous]')
                      ? 'Anonymous'
                      : zap.from?.displayName ||
                        zap.from?.email ||
                        (zap.transaction.extra?.from?.user
                          ? `User ${zap.transaction.extra.from.user.substring(0, 8)}`
                          : 'Unknown')}
                  </div>
                </div>
                <div className={styles.personDetails}>
                  <img
                    className={styles.avatarIcon}
                    alt=""
                    src="avatar.png"
                    style={{ display: 'none' }}
                  />
                  <div className={styles.userName}>
                    {zap.to?.displayName ||
                      zap.to?.email ||
                      (zap.transaction.extra?.to?.user
                        ? `User ${zap.transaction.extra.to.user.substring(0, 8)}`
                        : 'Unknown')}
                  </div>
                </div>
                <div
                  className={styles.userName}
                  title={zap.transaction.memo?.replace('[Anonymous] ', '')}
                >
                  {zap.transaction.memo?.replace('[Anonymous] ', '')}
                </div>
              </div>
              <div className={styles.transactionDetails}>
                <b className={styles.b}>
                  {Math.abs(
                    Math.floor(zap.transaction.amount / 1000),
                  ).toLocaleString()}
                </b>
                <img className={styles.icon} alt="" src={ZapIcon} />
              </div>
            </div>
          </div>
        ))
      ) : (
        <div>No data available</div>
      )}
      {filteredZaps.length > ITEMS_PER_PAGE && (
        <div className={styles.pagination}>
          <button
            onClick={firstPage}
            disabled={displayedPage === 1}
            className={styles.doubleArrow}
          >
            &#171; {/* Double left arrow */}
          </button>
          <button
            onClick={prevPage}
            disabled={displayedPage === 1}
            className={styles.singleArrow}
          >
            &#11164; {/* Single left arrow */}
          </button>
          <span>
            {displayedPage} / {totalPages}
          </span>
          <button
            onClick={nextPage}
            disabled={displayedPage === totalPages}
            className={styles.singleArrow}
          >
            &#11166; {/* Single right arrow */}
          </button>
          <button
            onClick={lastPage}
            disabled={displayedPage === totalPages}
            className={styles.doubleArrow}
          >
            &#187; {/* Double right arrow */}
          </button>
        </div>
      )}
    </div>
  );
};
export default FeedList;
