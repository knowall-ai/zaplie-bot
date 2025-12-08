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

// Wallet type identifiers - these match the naming convention used by the backend
// NOTE: If wallet naming conventions change on the backend, these must be updated
const WALLET_TYPE_ALLOWANCE = 'allowance';
const WALLET_TYPE_PRIVATE = 'private';

// Helper functions to identify wallet types by name
const isAllowanceWallet = (walletName: string): boolean =>
  walletName.toLowerCase().includes(WALLET_TYPE_ALLOWANCE);

const isPrivateWallet = (walletName: string): boolean =>
  walletName.toLowerCase().includes(WALLET_TYPE_PRIVATE);

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
        // Step 3: Get payments from both Allowance and Private wallets
        // We need both to match sender (Allowance) with receiver (Private)
        let allPayments: Transaction[] = [];
        const allowanceWalletIds = new Set<string>();

        for (const userData of allWalletsData) {
          // Filter to Allowance and Private wallets
          const relevantWallets = userData.wallets.filter(wallet =>
            isAllowanceWallet(wallet.name) || isPrivateWallet(wallet.name)
          );

          // Track allowance wallet IDs
          relevantWallets.forEach(wallet => {
            if (isAllowanceWallet(wallet.name)) {
              allowanceWalletIds.add(wallet.id);
            }
          });

          // Get payments from relevant wallets
          for (const wallet of relevantWallets) {
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

        // Filter: Only outgoing payments (negative amounts) FROM Allowance wallets
        // These are payments FROM Allowance TO Private wallets
        const allowanceTransactions = allPayments.filter(payment => {
          // Must be from an Allowance wallet
          if (!allowanceWalletIds.has(payment.wallet_id)) return false;
          // Must be outgoing (negative amount)
          if (payment.amount >= 0) return false;
          // Exclude weekly allowance cleared transactions
          if (payment.memo.includes('Weekly Allowance cleared')) return false;
          return true;
        });

        // Deduplicate internal transfers by checking_id
        const seenCheckingIds = new Set<string>();
        const deduplicatedTransactions = allowanceTransactions.filter(payment => {
          const cleanId = payment.checking_id?.replace('internal_', '') || '';

          if (cleanId) {
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
          const user = fetchedUsers.find(u => u.id === userData.userId);
          if (user) {
            userData.wallets.forEach(wallet => {
              walletToUserMap.set(wallet.id, user);
            });
          }
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
          // FROM = owner of the Allowance wallet (sender)
          const fromUser = walletToUserMap.get(transaction.wallet_id) || null;

          // TO = recipient (owner of the Private wallet that received the payment)
          let toUser: User | null = null;

          // Try to find matching internal payment (the receiving side)
          const cleanCheckingId = transaction.checking_id?.replace('internal_', '') || '';
          const matchingPayments = paymentsByCheckingId.get(cleanCheckingId) || [];
          const matchingPayment = matchingPayments.find(p => p.wallet_id !== transaction.wallet_id);

          if (matchingPayment) {
            toUser = walletToUserMap.get(matchingPayment.wallet_id) || null;
            if (!toUser) {
              console.warn(`Receiver wallet ${matchingPayment.wallet_id} found but user mapping missing`);
            }
          }

          // Fallback 1: Try extra.to.user field
          if (!toUser && transaction.extra?.to?.user) {
            const toUserId = transaction.extra.to.user;
            toUser = fetchedUsers.find(f => f.id === toUserId) || null;
          }

          // Fallback 2: Try extra.to.name for display purposes (external payments)
          if (!toUser && transaction.extra?.to?.name) {
            console.debug(`Payment to external recipient: ${transaction.extra.to.name}`);
          }

          // Log if receiver still couldn't be determined
          if (!toUser) {
            console.warn(`Could not determine receiver for transaction ${transaction.checking_id}`, {
              memo: transaction.memo,
              extra: transaction.extra
            });
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
                    {zap.from?.displayName || zap.from?.email ||
                     (zap.transaction.extra?.from?.user ? `User ${zap.transaction.extra.from.user.substring(0, 8)}` : 'Unknown')}
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