import React, { useEffect, useState, useRef } from 'react';
import styles from './FeedList.module.css';
import ZapIcon from '../images/ZapIcon.svg';
import { fetchZapActivity } from '../utils/walletUtilities';

interface FeedListProps {
  timestamp?: number | null;
}
interface ZapTransaction {
  from: User;
  to: User;
  transaction: Transaction;
}

const ITEMS_PER_PAGE = 10; // Items per page
const MAX_RECORDS = 100; // Maximum records to display

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
  const [zaps, setZaps] = useState<ZapTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [truncated, setTruncated] = useState(false);
  const initialRender = useRef(true);

  // State for sorting (excluding the Memo field)
  const [sortField, setSortField] = useState<'time' | 'from' | 'to' | 'amount'>(
    'time',
  );
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    const fetchZapsStepByStep = async () => {
      setLoading(true);
      setError(null);

      try {
        // Whole seconds: fetchZapActivity refuses a fractional window.
        const since =
          timestamp && timestamp > 0 ? Math.floor(timestamp) : undefined;
        const {
          users,
          transfers,
          truncated: isTruncated,
        } = await fetchZapActivity(since);
        if (users.length === 0) {
          setError(
            'Unable to load users. Please check your connection and try again.',
          );
          return;
        }
        setTruncated(isTruncated);

        // One row per verified Allowance -> Private transfer between two
        // different people. Self-zaps and weekly sweeps are left out by
        // fetchZapActivity, the same rule the leaderboard and the bot's
        // leaderboard apply.
        setZaps(transfers.slice(0, MAX_RECORDS));
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? `Failed to load activity feed: ${error.message}`
            : 'Unable to load activity feed. Please refresh and try again.';
        setError(errorMessage);
        console.error('Error in fetchZapsStepByStep:', error);
      } finally {
        setLoading(false);
      }
    };

    if (initialRender.current) {
      initialRender.current = false;
      setZaps([]);
      fetchZapsStepByStep();
    } else {
      fetchZapsStepByStep();
    }
  }, [timestamp]);

  const handleSort = (field: 'time' | 'from' | 'to' | 'amount') => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const sortedZaps = [...zaps].sort((a, b) => {
    let valA, valB;

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
      default:
        valA = 0;
        valB = 0;
    }

    if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
    if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

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
  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentItems = filteredZaps.slice(indexOfFirstItem, indexOfLastItem);

  const nextPage = () => setCurrentPage(prev => Math.min(prev + 1, totalPages));
  const prevPage = () => setCurrentPage(prev => Math.max(prev - 1, 1));
  const firstPage = () => setCurrentPage(1);
  const lastPage = () => setCurrentPage(totalPages);

  if (loading) {
    return <div>Loading...</div>;
  }
  if (error) {
    return <div>{error}</div>;
  }
  return (
    <div className={styles.feedlist}>
      {truncated && (
        <div role="status" className={styles.truncatedNotice}>
          History truncated: only the most recent payments could be read, so
          this feed is incomplete.
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
            data-testid="feed-row"
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
                      : zap.from.displayName || zap.from.email}
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
                    {zap.to.displayName || zap.to.email}
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
            disabled={currentPage === 1}
            className={styles.doubleArrow}
          >
            &#171; {/* Double left arrow */}
          </button>
          <button
            onClick={prevPage}
            disabled={currentPage === 1}
            className={styles.singleArrow}
          >
            &#11164; {/* Single left arrow */}
          </button>
          <span>
            {currentPage} / {totalPages}
          </span>
          <button
            onClick={nextPage}
            disabled={currentPage === totalPages}
            className={styles.singleArrow}
          >
            &#11166; {/* Single right arrow */}
          </button>
          <button
            onClick={lastPage}
            disabled={currentPage === totalPages}
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
