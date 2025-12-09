import React, { useEffect, useState, useContext } from 'react';
import styles from './WalletTransactionLog.module.css';
import {
  getUsers,
  getWalletTransactionsSince,
  getUserWallets,
} from '../services/lnbitsServiceLocal';
import ArrowIncoming from '../images/ArrowIncoming.svg';
import ArrowOutgoing from '../images/ArrowOutcoming.svg';
import moment from 'moment';
import { useMsal } from '@azure/msal-react';
import { RewardNameContext } from './RewardNameContext';

interface WalletTransactionLogProps {
  activeTab?: string;
  activeWallet?: string;
  filterZaps?: (activeTab: string) => void;
}

const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;

const WalletTransactionLog: React.FC<WalletTransactionLogProps> = ({
  activeTab,
  activeWallet,
}) => {
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([]); // Cache all transactions
  const [displayedTransactions, setDisplayedTransactions] = useState<Transaction[]>([]); // Filtered transactions to display
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentWallet, setCurrentWallet] = useState<string | undefined>(undefined); // Track which wallet data is cached for

  const { accounts } = useMsal();

  // Effect to fetch data when wallet changes
  useEffect(() => {
    // Calculate the timestamp for 30 days ago
    const sevenDaysAgo = Date.now() / 1000 - 30 * 24 * 60 * 60;

    // Use the provided timestamp or default to 7 days ago
    const paymentsSinceTimestamp = sevenDaysAgo;

    const account = accounts[0];

    const fetchTransactions = async () => {
      setLoading(true);
      setError(null);

      let fetchedTransactions: Transaction[] = [];

      try {
        // First, fetch all users
        const allUsers = await getUsers(adminKey, {});
        if (allUsers) {
          setUsers(allUsers);
        }

        const currentUserLNbitDetails = await getUsers(adminKey, {
          aadObjectId: account.localAccountId,
        });

        if (currentUserLNbitDetails && currentUserLNbitDetails.length > 0) {
          const user = currentUserLNbitDetails[0];

          // Fetch user's wallets
          const userWallets = await getUserWallets(adminKey, user.id);

          // Create a wallet ID to user mapping for ALL users
          const walletToUserMap = new Map<string, User>();

          // For each user, fetch their wallets and create mapping
          if (allUsers) {
            for (const u of allUsers) {
              try {
                const wallets = await getUserWallets(adminKey, u.id);
                if (wallets) {
                  wallets.forEach(wallet => {
                    walletToUserMap.set(wallet.id, u);
                  });
                }
              } catch (err) {
                console.error(`Error fetching wallets for user ${u.id}:`, err);
              }
            }
          }

          // Fetch ALL payments from ALL wallets to enable matching
          const allPayments: Transaction[] = [];

          if (allUsers) {
            for (const u of allUsers) {
              try {
                const wallets = await getUserWallets(adminKey, u.id);
                if (wallets) {
                  for (const wallet of wallets) {
                    try {
                      const payments = await getWalletTransactionsSince(
                        wallet.inkey,
                        paymentsSinceTimestamp,
                        null,
                      );
                      allPayments.push(...payments);
                    } catch (err) {
                      console.error(`Error fetching payments for wallet ${wallet.id}:`, err);
                    }
                  }
                }
              } catch (err) {
                console.error(`Error fetching wallets for user ${u.id}:`, err);
              }
            }
          }

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

          let inkey: any = null;

          if (userWallets && userWallets.length > 0) {
            if (activeWallet === 'Private') {
              const privateWallet = userWallets.find(w => w.name.toLowerCase().includes('private'));
              inkey = privateWallet?.inkey;
            } else {
              const allowanceWallet = userWallets.find(w => w.name.toLowerCase().includes('allowance'));
              inkey = allowanceWallet?.inkey;
            }
          } else {
            console.error('No wallets found for user');
          }

          const transactions = await getWalletTransactionsSince(
            inkey,
            paymentsSinceTimestamp,
            null,
          );

          // Don't filter by tab here - we'll cache ALL transactions and filter later
          for (const transaction of transactions) {
            const walletOwner = walletToUserMap.get(transaction.wallet_id);
            const isIncoming = transaction.amount > 0;

            // Initialize extra.from and extra.to
            if (!transaction.extra) {
              transaction.extra = {};
            }

            // Try to find matching internal payment (the other side of the transfer)
            const cleanCheckingId = transaction.checking_id?.replace('internal_', '') || '';
            const matchingPayments = paymentsByCheckingId.get(cleanCheckingId) || [];
            const matchingPayment = matchingPayments.find(p => p.wallet_id !== transaction.wallet_id);

            let otherUser: User | null = null;

            // First try to find the other party via matching payment
            if (matchingPayment) {
              otherUser = walletToUserMap.get(matchingPayment.wallet_id) || null;
            }

            // If no matching payment found, try to extract from memo
            if (!otherUser && transaction.memo) {
              // Try to find user by matching displayName or email in memo
              const memo = transaction.memo.toLowerCase();
              const foundUser = allUsers?.find(u => {
                const displayName = u.displayName?.toLowerCase();
                const email = u.email?.toLowerCase();
                const username = u.email?.split('@')[0]?.toLowerCase();

                return (
                  (displayName && memo.includes(displayName)) ||
                  (email && memo.includes(email)) ||
                  (username && memo.includes(username))
                );
              });

              if (foundUser) {
                otherUser = foundUser;
              }
            }

            if (isIncoming) {
              // For incoming: TO = current wallet owner, FROM = other party
              transaction.extra.to = walletOwner || null;
              transaction.extra.from = otherUser;
            } else {
              // For outgoing: FROM = current wallet owner, TO = other party
              transaction.extra.from = walletOwner || null;
              transaction.extra.to = otherUser;
            }
          }

          fetchedTransactions = fetchedTransactions.concat(transactions);
        }

        // Cache all transactions
        setAllTransactions(fetchedTransactions);
        setCurrentWallet(activeWallet);
      } catch (error) {
        if (error instanceof Error) {
          setError(`Failed to fetch transactions: ${error.message}`);
        } else {
          setError('An unknown error occurred while fetching transactions');
        }
        console.error(error);
      } finally {
        setLoading(false);
      }
    };

    // Only fetch if wallet changed or no data cached
    if (currentWallet !== activeWallet) {
      setAllTransactions([]);
      setDisplayedTransactions([]);
      fetchTransactions();
    }
  }, [activeWallet, accounts, currentWallet, users]);

  // Separate effect to filter cached transactions when activeTab changes
  useEffect(() => {
    if (allTransactions.length === 0) {
      setDisplayedTransactions([]);
      return;
    }

    let filtered: Transaction[];
    if (activeTab === 'sent') {
      filtered = allTransactions.filter(f => f.amount < 0);
    } else if (activeTab === 'received') {
      filtered = allTransactions.filter(f => f.amount > 0);
    } else {
      filtered = allTransactions;
    }

    setDisplayedTransactions(filtered);
  }, [activeTab, allTransactions]);
  
  const rewardNameContext = useContext(RewardNameContext);
  if (!rewardNameContext) {
    return null; // or handle the case where the context is not available
  }
const rewardsName = rewardNameContext.rewardName;

  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>{error}</div>;
  }

  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>{error}</div>;
  }



  return (
    <div className={styles.feedlist}>
      {displayedTransactions
        ?.sort((a, b) => {
          // Convert both times to numbers for sorting
          const timeA = typeof a.time === 'number' ? a.time : new Date(a.time).getTime() / 1000;
          const timeB = typeof b.time === 'number' ? b.time : new Date(b.time).getTime() / 1000;
          return timeB - timeA;
        })
        .map((transaction, index) => (
          <div
            key={transaction.checking_id || index}
            className={styles.bodycell}
          >
            <div className={styles.bodyContents}>
              <div className={styles.mainContentStack}>
                <img
                  className={styles.avatarIcon}
                  alt=""
                  src={
                    (transaction.amount as number) < 0
                      ? ArrowOutgoing
                      : ArrowIncoming
                  }
                />

                <div className={styles.userName}>
                  <p className={styles.lightHelightInItems}>
                    {' '}
                    <b>
                      {transaction.extra?.tag === 'zap'
                        ? 'Zap!'
                        : transaction.extra?.tag ?? 'Regular transaction'}
                    </b>
                  </p>
                  {/* 
                    Dynamically calculate and display the time difference between the transaction and the current time.
                    The output format adapts based on the time elapsed:
                    - Less than 60 seconds: show in seconds.
                    - Less than 1 hour: show in minutes.
                    - Less than 1 day: show in hours.
                    - More than 1 day: show in days.
                  */}
                  <div className={styles.lightHelightInItems}>
                    {(() => {
                      const now = moment();
                      // Convert time to milliseconds for moment
                      const timeInMs = typeof transaction.time === 'number'
                        ? transaction.time * 1000
                        : new Date(transaction.time).getTime();
                      const transactionTime = moment(timeInMs);
                      const diffInSeconds = now.diff(transactionTime, 'seconds');

                      if (diffInSeconds < 60) {
                        return `${diffInSeconds} seconds ago `;
                      } else if (diffInSeconds < 3600) {
                        const diffInMinutes = now.diff(transactionTime, 'minutes');
                        return `${diffInMinutes} minutes ago `;
                      } else if (diffInSeconds < 86400) {
                        const diffInHours = now.diff(transactionTime, 'hours');
                        return `${diffInHours} hours ago `;
                      } else {
                        const diffInDays = now.diff(transactionTime, 'days');
                        return `${diffInDays} days ago `;
                      }
                    })()}
                    {(transaction.amount as number) < 0 ? 'to' : 'from'}{' '} <b>{(transaction.amount as number) < 0
                        ? transaction.extra?.to?.displayName || transaction.extra?.to?.email || 'Unknown'
                        : transaction.extra?.from?.displayName || transaction.extra?.from?.email || 'Unknown'}{' '}</b>
                  </div>
                  <p className={styles.lightHelightInItems}>
                    {transaction.memo}
                  </p>
                </div>
              </div>
              <div
                className={styles.transactionDetailsAllowance}
                style={{
                  color:
                    (transaction.amount as number) < 0 ? '#E75858' : '#00A14B',
                }}
              >
                <div className={styles.lightHelightInItems}>
                  {' '}
                  <b className={styles.b}>
                    {transaction.amount < 0
                      ? transaction.amount / 1000
                      : '+' + transaction.amount / 1000}
                  </b>{' '}
                  {rewardsName}{' '}
                </div>
                <div
                  style={{ display: 'none' }}
                  className={styles.lightHelightInItems}
                >
                  {' '}
                  about $0.11{' '}
                </div>
              </div>
            </div>
          </div>
        ))}
      {displayedTransactions.length === 0 && <div>No transactions to show.</div>}
    </div>
  );
};

export default WalletTransactionLog;