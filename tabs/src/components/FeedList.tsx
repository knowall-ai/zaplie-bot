import React, { useEffect, useState, useRef } from 'react';
import styles from './FeedList.module.css';
import ZapIcon from '../images/ZapIcon.svg';
import {
  getUsers,
  getUserWallets,
  getWalletTransactionsSince
} from '../services/lnbitsServiceLocal';

interface FeedListProps {
  timestamp?: number | null;
  allZaps?: Transaction[];
  allUsers?: User[];
  isLoading?: boolean;
}
interface ZapTransaction {
  from: User | null;
  to: User | null;
  transaction: Transaction;
}


const ITEMS_PER_PAGE = 10; // Items per page
const MAX_RECORDS = 100; // Maximum records to display

const FeedList: React.FC<FeedListProps> = ({
  timestamp,
  allZaps = [],
  allUsers = [],
  isLoading = false
}) => {
  const [zaps, setZaps] = useState<ZapTransaction[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const initialRender = useRef(true);

  // NEW: State for sorting (excluding the Memo field)
  const [sortField, setSortField] = useState<'time' | 'from' | 'to' | 'amount'>(
    'time',
  );
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Get admin key from environment
  const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;

  useEffect(() => {
    const fetchZapsStepByStep = async () => {
      setLoading(true);
      setError(null);

      try {
        const paymentsSinceTimestamp =
          timestamp === null || timestamp === undefined || timestamp === 0
            ? 0
            : timestamp;

        // Step 1: Get all users from /users/api/v1/user
        const fetchedUsers = await getUsers(adminKey, {});
        if (!fetchedUsers || fetchedUsers.length === 0) {
          setError('Unable to load users. Please check your connection and try again.');
          setLoading(false);
          return;
        }
        setUsers(fetchedUsers);

        // Step 2: For each user, get wallets using /users/api/v1/user/{userId}/wallet
        const allWalletsData: { userId: string; wallets: Wallet[] }[] = [];
        const allWalletsArray: Wallet[] = [];

        for (const user of fetchedUsers) {
          const userWallets = await getUserWallets(adminKey, user.id);
          const wallets = userWallets || [];

          allWalletsData.push({
            userId: user.id,
            wallets: wallets
          });
          allWalletsArray.push(...wallets);
        }
        // Step 3: For each wallet, get payments from Private and Allowance wallets only
        let allPayments: Transaction[] = [];

        for (const userData of allWalletsData) {
          // Filter to only Private and Allowance wallets
          const filteredWallets = userData.wallets.filter(wallet => {
            const walletName = wallet.name.toLowerCase();
            return walletName.includes('private') || walletName.includes('allowance');
          });

          // Get payments from filtered wallets only
          for (const wallet of filteredWallets) {
            try {
              const payments = await getWalletTransactionsSince(
                wallet.inkey,
                paymentsSinceTimestamp,
                null
              );
              allPayments = allPayments.concat(payments);
            } catch (err) {
              console.error(`Error fetching payments for wallet ${wallet.id}:`, err);
            }
          }
        }

        // Filter out weekly allowance cleared transactions only
        const allowanceTransactions = allPayments.filter(
          f => !f.memo.includes('Weekly Allowance cleared'),
        );

        // Deduplicate internal transfers - only show the incoming side (positive amount)
        // For internal transfers, we have 2 records with the same checking_id (one negative, one positive)
        // We only want to show one transaction per transfer
        const seenCheckingIds = new Set<string>();
        const deduplicatedTransactions = allowanceTransactions.filter(payment => {
          const cleanId = payment.checking_id?.replace('internal_', '') || '';

          // If this is an internal transfer (has matching checking_id)
          if (cleanId && payment.checking_id?.startsWith('internal_')) {
            // Only show the incoming side (positive amount)
            if (payment.amount < 0) {
              return false; // Skip outgoing side
            }

            // Check if we've already seen this checking_id
            if (seenCheckingIds.has(cleanId)) {
              return false; // Skip duplicate
            }
            seenCheckingIds.add(cleanId);
          }

          return true;
        });

        // Create wallet ID to user mapping
        const walletToUserMap = new Map<string, User>();
        allWalletsData.forEach(userData => {
          userData.wallets.forEach(wallet => {
            walletToUserMap.set(wallet.id, fetchedUsers.find(u => u.id === userData.userId)!);
          });
        });

        // Create a map of all payments by checking_id for internal transfer matching
        const paymentsByCheckingId = new Map<string, Transaction[]>();
        allPayments.forEach(payment => {
          const cleanId = payment.checking_id?.replace('internal_', '') || '';
          if (cleanId) {
            const existing = paymentsByCheckingId.get(cleanId) || [];
            existing.push(payment);
            paymentsByCheckingId.set(cleanId, existing);
          }
        });

        const allowanceZaps = deduplicatedTransactions.map((transaction, index) => {
          const walletOwner = walletToUserMap.get(transaction.wallet_id) || null;

          // Determine if this is incoming (positive amount) or outgoing (negative amount)
          const isIncoming = transaction.amount > 0;

          let fromUser: User | null = null;
          let toUser: User | null = null;

          // Try to find matching internal payment (the other side of the transfer)
          const cleanCheckingId = transaction.checking_id?.replace('internal_', '') || '';
          const matchingPayments = paymentsByCheckingId.get(cleanCheckingId) || [];
          const matchingPayment = matchingPayments.find(p => p.wallet_id !== transaction.wallet_id);

          if (isIncoming) {
            // For incoming payments: TO = wallet owner
            toUser = walletOwner;

            // FROM = the owner of the matching outgoing payment (if found)
            if (matchingPayment) {
              fromUser = walletToUserMap.get(matchingPayment.wallet_id) || null;
            } else {
              // Fallback to extra field
              const fromUserId = transaction.extra?.from?.user;
              fromUser = fromUserId ? fetchedUsers.find(f => f.id === fromUserId) || null : null;
            }
          } else {
            // For outgoing payments: FROM = wallet owner
            fromUser = walletOwner;

            // TO = the owner of the matching incoming payment (if found)
            if (matchingPayment) {
              toUser = walletToUserMap.get(matchingPayment.wallet_id) || null;
            } else {
              // Fallback to extra field
              const toUserId = transaction.extra?.to?.user;
              toUser = toUserId ? fetchedUsers.find(f => f.id === toUserId) || null : null;
            }
          }


          return {
            from: fromUser,
            to: toUser,
            transaction: transaction,
          };
        });

        // Limit to MAX_RECORDS (100 records)
        const limitedZaps = allowanceZaps.slice(0, MAX_RECORDS);

        setZaps(limitedZaps);
      } catch (error) {
        const errorMessage = error instanceof Error
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
  }, [timestamp, adminKey]);
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
                    {(() => {
                      const timestamp = zap.transaction.time;
                      // Try to parse as ISO string first, then Unix timestamp
                      let date = new Date(timestamp);
                      if (isNaN(date.getTime()) && typeof timestamp === 'number') {
                        // Try as Unix timestamp (seconds)
                        date = new Date(timestamp * 1000);
                      }
                      if (isNaN(date.getTime())) {
                        return `Invalid: ${timestamp}`;
                      }
                      // UK format: DD/MM/YYYY HH:MM (24-hour)
                      return `${date.toLocaleDateString('en-GB')} ${date.toLocaleTimeString('en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}`;
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
                    {zap.transaction.memo?.startsWith('[Anonymous]') ? 'Anonymous' :
                     (zap.from?.displayName || zap.from?.email ||
                     (zap.transaction.extra?.from?.user ? `User ${zap.transaction.extra.from.user.substring(0, 8)}` : 'Unknown'))}
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
                    {zap.to?.displayName || zap.to?.email ||
                     (zap.transaction.extra?.to?.user ? `User ${zap.transaction.extra.to.user.substring(0, 8)}` : 'Unknown')}
                  </div>
                </div>
                <div className={styles.userName} title={zap.transaction.memo?.replace('[Anonymous] ', '')}>
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