import React, { useEffect, useState } from 'react';
import styles from './Leaderboard.module.css';
import {
  getUsers,
  getWalletTransactionsSince,
} from '../services/lnbitsServiceLocal';
import ZapIcon from '../images/ZapIcon.svg';
import circleFirstPlace from '../images/circleFirstPlace.svg';
import CircleSecondPlace from '../images/circleSecondPlace.svg';
import circleThirdPlace from '../images/circleThirdPlace.svg';
import circleDefaultPlace from '../images/circleDefaultPlace.svg';
import AscendingIcon from '../images/ascending.svg';
import DescendingIcon from '../images/descending.svg';

interface LeaderboardProps {
  timestamp?: number | null;
}

interface PrivateWalletTransaction {
  userId: string;
  displayName: string;
  walletId: string;
  transaction: Transaction;
  time: number;
}

interface UserTransactionSummary {
  userId: string;
  displayName: string;
  walletId: string;
  totalAmountSats: number;
  rank: number;
}

const Leaderboard: React.FC<LeaderboardProps> = ({ timestamp }) => {
  const [userTransactionSummary, setUserTransactionSummary] = useState<
    UserTransactionSummary[]
  >([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isAscending, setIsAscending] = useState<boolean>(true);

  useEffect(() => {
    // Use the provided timestamp to 0
    const paymentsSinceTimestamp =
      timestamp === null || timestamp === undefined || timestamp === 0
        ? 0
        : timestamp;

    const fetchUsersAndPrivateWalletTransactions = async () => {
      try {
        const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;
        if (!adminKey) {
          throw new Error('Admin key is missing');
        }

        const usersData = await getUsers(adminKey, null); // Fetch all users

        if (usersData) {
          // Fetch wallets and transactions for each user's "Private" wallet
          const privateWalletTransactionsData: PrivateWalletTransaction[] = [];

          await Promise.all(
            usersData.map(async user => {
              //const wallets = await getUserWallets(adminKey, user.id);
              //const privateWallet = wallets?.find(wallet =>
              //  wallet.name.toLowerCase().includes('private'),
              //); // Find "Private" wallets only.
              const privateWallet = user.privateWallet;

              if (privateWallet) {
                /*
                const transactions = await getUserWalletTransactions(
                  privateWallet.id,
                  adminKey,
                  { tag: 'zap' }, // Filter to just zaps
                );*/
                const transactions = await getWalletTransactionsSince(
                  privateWallet.inkey,
                  paymentsSinceTimestamp,
                  { tag: 'zap' },
                );

                transactions.forEach(transaction => {
                  // Convert time to number (Unix timestamp in seconds)
                  const timeAsNumber = typeof transaction.time === 'number'
                    ? transaction.time
                    : new Date(transaction.time).getTime() / 1000;

                  privateWalletTransactionsData.push({
                    userId: user.id,
                    displayName: user.displayName,
                    walletId: privateWallet.id,
                    transaction,
                    time: timeAsNumber,
                  });
                });
              }
            }),
          );

          // Group and sum amounts by users
          const transactionSummary: { [key: string]: UserTransactionSummary } =
            {};

          privateWalletTransactionsData.forEach(entry => {
            const { userId, displayName, walletId, transaction } = entry;
            const amountInSats = transaction.amount / 1000; // Convert msats to sats

            if (!transactionSummary[userId]) {
              transactionSummary[userId] = {
                userId,
                displayName,
                walletId,
                totalAmountSats: 0,
                rank: 0, // Initial rank, to be assigned later
              };
            }

            // Sum the amounts
            transactionSummary[userId].totalAmountSats += amountInSats;
          });

          // Convert the summary object to an array and assign ranks
          const summaryArray = Object.values(transactionSummary);

          summaryArray.sort((a, b) => b.totalAmountSats - a.totalAmountSats); // Sort by amount in descending order
          summaryArray.forEach((userSummary, index) => {
            userSummary.rank = index + 1; // Assign ranks based on the sorted order
          });

          setUserTransactionSummary(summaryArray);
        } else {
          throw new Error('No users data returned from API');
        }
      } catch (error: unknown) {
        if (error instanceof Error) {
          setError(`Failed to fetch users: ${error.message}`);
        } else {
          setError('An unknown error occurred while fetching users');
        }
        console.error(error);
      } finally {
        setLoading(false);
      }
    };

    fetchUsersAndPrivateWalletTransactions();
  }, [timestamp]); // Re-fetch data when the timestamp changes

  const handleSort = () => {
    const sortedUsers = [...userTransactionSummary].sort((a, b) =>
      isAscending
        ? a.totalAmountSats - b.totalAmountSats
        : b.totalAmountSats - a.totalAmountSats,
    );
    setUserTransactionSummary(sortedUsers);
    setIsAscending(!isAscending);
  };

  const getTextColorByRank = (rank: number) => {
    if (rank === 1) return styles.goldAmount;
    if (rank === 2) return styles.silverAmount;
    if (rank === 3) return styles.bronzeAmount;
    return styles.defaultAmount;
  };

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
          <b className={styles.string}>Rank</b>
          <b className={styles.string2}>User</b>
          <div
            className={styles.stringWrapper}
            onClick={handleSort}
            style={{ cursor: 'pointer' }}
          >
            <b className={`${styles.string3} ${styles.b}`}>Zap amount</b>
            <img
              src={isAscending ? AscendingIcon : DescendingIcon}
              alt={isAscending ? 'Ascending' : 'Descending'}
              className={styles.sortIcon}
            />
          </div>
        </div>
      </div>

      <div className={`${styles.horizontalContainer} ${styles.table}`}>
        <ul>
          {userTransactionSummary.map(summary => (
            <li key={summary.userId} className={styles.bodycell}>
              <div className={styles.bodyContents}>
                <div className={styles.mainContentStack}>
                  <div className={styles.personDetails}>
                    <div className={styles.userRank}>
                      {summary.rank === 1 ? (
                        <div className={styles.firstPlace}>
                          <img
                            src={circleFirstPlace}
                            alt="First Place"
                            className={styles.circleFirstPlace}
                          />
                          <span
                            className={`${styles.rankNumber} ${styles.blackRank}`}
                          >
                            {summary.rank}
                          </span>
                        </div>
                      ) : summary.rank === 2 ? (
                        <div className={styles.secondPlace}>
                          <img
                            src={CircleSecondPlace}
                            alt="Second Place"
                            className={styles.circleSecondPlace}
                          />
                          <span
                            className={`${styles.rankNumber} ${styles.blackRank}`}
                          >
                            {summary.rank}
                          </span>
                        </div>
                      ) : summary.rank === 3 ? (
                        <div className={styles.thirdPlace}>
                          <img
                            src={circleThirdPlace}
                            alt="Third Place"
                            className={styles.circleThirdPlace}
                          />
                          <span
                            className={`${styles.rankNumber} ${styles.blackRank}`}
                          >
                            {summary.rank}
                          </span>
                        </div>
                      ) : (
                        <div className={styles.defaultPlace}>
                          <img
                            src={circleDefaultPlace}
                            alt="Place"
                            className={styles.circleDefaultPlace}
                          />
                          <span className={`${styles.rankNumber}`}>
                            {summary.rank}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className={styles.userName}>
                      {summary.displayName}{' '}
                    </div>
                  </div>
                </div>
                <b
                  className={`${styles.b} ${
                    summary.rank <= 3 ? styles.yellowAmount : ''
                  } ${getTextColorByRank(summary.rank)}`}
                >
                  {new Intl.NumberFormat('en-US').format(
                    summary.totalAmountSats,
                  )}
                </b>
                <img className={styles.icon} alt="Zap Icon" src={ZapIcon} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default Leaderboard;
