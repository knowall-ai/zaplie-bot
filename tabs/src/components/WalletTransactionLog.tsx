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
    const thirtyDaysAgo = Date.now() / 1000 - 30 * 24 * 60 * 60;
    const paymentsSinceTimestamp = thirtyDaysAgo;

    const account = accounts[0];

    const fetchTransactions = async () => {
      setLoading(true);
      setError(null);

      try {
        // Fetch all users once (cached in service layer)
        const allUsers = await getUsers(adminKey, {});
        if (allUsers) {
          setUsers(allUsers);
        }

        // Get current user's LNbits details
        const currentUserLNbitDetails = await getUsers(adminKey, {
          aadObjectId: account.localAccountId,
        });

        if (!currentUserLNbitDetails || currentUserLNbitDetails.length === 0) {
          throw new Error('User not found in LNbits');
        }

        const user = currentUserLNbitDetails[0];

        // Fetch only the current user's wallets
        const userWallets = await getUserWallets(adminKey, user.id);

        if (!userWallets || userWallets.length === 0) {
          throw new Error('No wallets found for user');
        }

        // Find the selected wallet
        let selectedWallet: Wallet | undefined;
        if (activeWallet === 'Private') {
          selectedWallet = userWallets.find(w => w.name.toLowerCase() === 'private') ||
                           userWallets.find(w => w.name.toLowerCase().includes('private'));
        } else {
          selectedWallet = userWallets.find(w => w.name.toLowerCase() === 'allowance') ||
                           userWallets.find(w => w.name.toLowerCase().includes('allowance'));
        }

        if (!selectedWallet?.inkey) {
          const walletType = activeWallet === 'Private' ? 'Private' : 'Allowance';
          throw new Error(`${walletType} wallet not found for user`);
        }

        // Fetch transactions only for the current user's selected wallet
        const transactions = await getWalletTransactionsSince(
          selectedWallet.inkey,
          paymentsSinceTimestamp,
          null,
        );

        // Build wallet-to-user mapping and fetch all transactions for matching
        const walletToUserMap = new Map<string, User>();
        const allPayments: Transaction[] = [];

        if (allUsers) {
          // Fetch all wallets and their transactions in parallel for efficiency
          const walletPromises = allUsers.map(async (u) => {
            try {
              const wallets = await getUserWallets(adminKey, u.id);
              if (wallets) {
                // Map wallets to user
                wallets.forEach(wallet => {
                  walletToUserMap.set(wallet.id, u);
                });

                // Fetch transactions from Private and Allowance wallets only
                for (const wallet of wallets) {
                  const walletName = wallet.name.toLowerCase();
                  if (walletName === 'private' || walletName === 'allowance') {
                    try {
                      const payments = await getWalletTransactionsSince(
                        wallet.inkey,
                        paymentsSinceTimestamp,
                        null
                      );
                      allPayments.push(...payments);
                    } catch (err) {
                      // Silently continue
                    }
                  }
                }
              }
            } catch (err) {
              // Silently continue if wallet fetch fails for a user
            }
          });

          await Promise.all(walletPromises);
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

        // Process transactions to add from/to user info
        for (const transaction of transactions) {
          const isIncoming = transaction.amount > 0;
          let otherUser: User | null = null;

          // Try to find matching internal payment (the other side of the transfer)
          const cleanCheckingId = transaction.checking_id?.replace('internal_', '') || '';
          const matchingPayments = paymentsByCheckingId.get(cleanCheckingId) || [];
          const matchingPayment = matchingPayments.find(p => p.wallet_id !== transaction.wallet_id);

          if (matchingPayment) {
            otherUser = walletToUserMap.get(matchingPayment.wallet_id) || null;
          }

          // Fall back to memo text matching if no match found
          if (!otherUser && transaction.memo && allUsers) {
            const memo = transaction.memo.toLowerCase();
            otherUser = allUsers.find(u => {
              const displayName = u.displayName?.toLowerCase();
              const email = u.email?.toLowerCase();
              const username = u.email?.split('@')[0]?.toLowerCase();
              return (
                (displayName && memo.includes(displayName)) ||
                (email && memo.includes(email)) ||
                (username && memo.includes(username))
              );
            }) || null;
          }

          // Set the from/to fields
          if (!transaction.extra) {
            transaction.extra = {};
          }

          if (isIncoming) {
            transaction.extra.to = user;
            transaction.extra.from = otherUser;
          } else {
            transaction.extra.from = user;
            transaction.extra.to = otherUser;
          }
        }

        setAllTransactions(transactions);
        setCurrentWallet(activeWallet);
      } catch (error) {
        console.error('WalletTransactionLog fetch error:', error);
        if (error instanceof Error) {
          if (error.message === 'Failed to fetch') {
            setError('Unable to connect to the server. Please check your network connection and try again.');
          } else if (error.message.includes('wallet not found')) {
            setError(`${activeWallet === 'Private' ? 'Private' : 'Allowance'} wallet is not available for your account.`);
          } else {
            setError(`Failed to load transactions: ${error.message}`);
          }
        } else {
          setError('An unexpected error occurred. Please refresh and try again.');
        }
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
  }, [activeWallet, accounts, currentWallet]);

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