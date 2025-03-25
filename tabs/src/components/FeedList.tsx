import React, { useEffect, useState, useRef } from 'react';
import styles from './FeedList.module.css';
import ZapIcon from '../images/ZapIcon.svg';
import { useCache } from '../utils/CacheContext';
interface FeedListProps {
  timestamp?: number | null;
  allZaps: Transaction[];
  allUsers: User[];
  isLoading: boolean;
}
interface ZapTransaction {
  from: User | null;
  to: User | null;
  transaction: Transaction;
}


const ITEMS_PER_PAGE = 10; // Items per page

const FeedList: React.FC<FeedListProps> = ({
  timestamp,
  allZaps,
  allUsers,
  isLoading
}) => {
  const [zaps, setZaps] = useState<ZapTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const initialRender = useRef(true);
  const { cache, setCache } = useCache();

  // NEW: State for sorting (excluding the Memo field)
  const [sortField, setSortField] = useState<'time' | 'from' | 'to' | 'amount'>(
    'time',
  );
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    //alert('FEED PARAMETER:' + timestamp);

    //setZaps(allZaps);
    if (cache['allZaps']) {
      console.log('FEED cache:', cache['allZaps']);
    }
    const paymentsSinceTimestamp =
      timestamp === null || timestamp === undefined || timestamp === 0
        ? 0
        : timestamp;
    const fetchZaps = async () => {
      setLoading(isLoading);
      setError(null);

      try {
        const paymentsSinceTimestamp =
          timestamp === null || timestamp === undefined || timestamp === 0
            ? 0
            : timestamp;

        let loadZaps: ZapTransaction[] = [];

        const allowanceTransactions = allZaps.filter(
          f =>
            f.time > paymentsSinceTimestamp &&
            !f.memo.includes('Weekly Allowance cleared'),
        );

        const allowanceZaps = allowanceTransactions.flat().map(transaction => ({
          from: allUsers?.find(
            f => f.id === transaction.extra?.from?.user,
          ) as User,
          to: allUsers?.find(f => f.id === transaction.extra?.to?.user) as User,
          transaction: transaction,
        }));

        loadZaps = loadZaps.concat(allowanceZaps);

        setZaps(loadZaps);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : 'An unknown error occurred',
        );
        console.error(error);
      } finally {
        setLoading(isLoading);
      }
    };

    if (initialRender.current) {
      initialRender.current = false;
      // Clear the zaps
      setZaps([]);
      fetchZaps();
    } else {
      console.log(`Timestamp updated: ${timestamp}`);
      fetchZaps();
    }
  }, [timestamp, allZaps, allUsers]);
  // NEW: Function to handle header clicks for sorting
  const handleSort = (field: 'time' | 'from' | 'to' | 'amount') => {
    if (sortField === field) {
      // Toggle sort order if the same field is clicked
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      // Change sort field and set default order to ascending
      setSortField(field);
      setSortOrder('asc');
    }
  };
  // NEW: Sort the zaps array based on the selected sort field and order
  const sortedZaps = [...zaps].sort((a, b) => {
    let valA, valB;

    switch (sortField) {
      case 'time':
        valA = a.transaction.time;
        valB = b.transaction.time;
        break;
      case 'from':
        valA = a.from?.displayName || '';
        valB = b.from?.displayName || '';
        break;
      case 'to':
        valA = a.to?.displayName || '';
        valB = b.to?.displayName || '';
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

  // Calculate pagination variables
  const totalPages = Math.ceil(sortedZaps.length / ITEMS_PER_PAGE);
  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentItems = sortedZaps.slice(indexOfFirstItem, indexOfLastItem);

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
              Amount {sortField === 'amount' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
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
                    {new Date(zap.transaction.time * 1000).toLocaleDateString()}{' '}
                    {new Date(zap.transaction.time * 1000).toLocaleTimeString(
                      [],
                      {
                        hour: '2-digit',
                        minute: '2-digit',
                      },
                    )}
                  </div>
                </div>
                <div className={styles.personDetails}>
                  <img
                    className={styles.avatarIcon}
                    alt=""
                    src="avatar.png"
                    style={{ display: 'none' }}
                  />
                  <div className={styles.userName}>{zap.from?.displayName}</div>
                </div>
                <div className={styles.personDetails}>
                  <img
                    className={styles.avatarIcon}
                    alt=""
                    src="avatar.png"
                    style={{ display: 'none' }}
                  />
                  <div className={styles.userName}>{zap.to?.displayName}</div>
                </div>
                <div className={styles.userName} title={zap.transaction.memo}>
                  {zap.transaction.memo}
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
      {sortedZaps.length > ITEMS_PER_PAGE && (
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