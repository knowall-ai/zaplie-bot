import { FunctionComponent, useCallback, useState, useEffect } from 'react';
import styles from './TotalZapsComponent.module.css';
//import lnbitsService from '../services/lnbitsServiceLocal';
/// <reference path = "../global.d.ts" />
import {
  getWallets,
  getUserWallets,
  getUsers,
  getWalletTransactionsSince,
} from '../services/lnbitsServiceLocal';
import { getUserName } from '../utils/walletUtilities';

export interface ZapSent {
  totalZaps: number;
  averagePerUser: number;
  averagePerDay: number;
  biggestZap: number;
  zapsFromCopilots: number;
  zapsToCopilots: number;
}

const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;

const TotalZapsComponent: FunctionComponent = () => {
  const [activePeriod, setActivePeriod] = useState<number | null>(null);
  const [zaps, setZaps] = useState<Transaction[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [totalZaps, setTotalZaps] = useState<number>(0);
  const [totalUsers, setTotalUsers] = useState<number>(0);
  const [averagePerDay, setAveragePerDay] = useState<number>(0); // State for average per day
  const [biggestZap, setBiggestZap] = useState<number>(0); // State for biggest zap
  const [averagePerUser, setAveragePerUser] = useState<number>(0); // State for average per user
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const zapsSent: ZapSent = {
    totalZaps: totalZaps,
    averagePerUser: averagePerUser,
    averagePerDay: averagePerDay,
    biggestZap: biggestZap,
    zapsFromCopilots: 0,
    zapsToCopilots: 0,
  };

  const today = new Date();

  useEffect(() => {
    const fetchZaps = async () => {
      setError(null);
      setLoading(true);

      try {
        let allZaps: Transaction[] = [];

        const users = await getUsers(adminKey, {});
        console.log('Users: ', users);

        if (users) {
          setUsers(users);
          for (const user of users) {
            const wallets = await getUserWallets(adminKey, user.id);
            console.log('Wallets: ', wallets);
            if (wallets) {
              const allowanceWallets = wallets.filter(
                wallet => wallet.name === 'Allowance',
              );

              for (const wallet of allowanceWallets) {
                const transactions = await getWalletTransactionsSince(
                  wallet.inkey,
                  0, // all time
                  { tag: 'zap' },
                );

                allZaps = allZaps.concat(transactions);
              }
            } else {
              console.log('No wallets found for user: ', user.id);
            }
          }
        }

        console.log('All zaps: ', allZaps);

        setZaps(allZaps); // Update zaps with new data
      } catch (error) {
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

    fetchZaps();
  }, []); // Empty dependency array ensures this runs once on mount

  useEffect(() => {
    if (zaps.length > 0) {
      console.log('Zaps: ', zaps);

      // Calculate the total amount considering only negative values
      const total =
        zaps
          .filter(zap => zap.amount < 0)
          .reduce((sum, zap) => sum + zap.amount, 0) / 1000;
      setTotalZaps(Math.floor(Math.abs(total))); // Convert to positive

      // Calculate the number of days since the first zap
      const currentTime = Date.now() / 1000;
      const firstZapTime = Math.min(...zaps.map(zap => zap.time));
      const numberOfDays = (currentTime - firstZapTime) / (24 * 60 * 60);
      const averagePerDay = total / numberOfDays;
      setAveragePerDay(Math.floor(Math.abs(averagePerDay)));

      const averagePerUser = total / users.length;
      setAveragePerUser(Math.floor(Math.abs(averagePerUser)));

      // Calculate the biggest zap considering only negative values
      const negativeZaps = zaps.filter(zap => zap.amount < 0);
      const maxZap =
        (negativeZaps.length > 0
          ? Math.max(...negativeZaps.map(zap => Math.abs(zap.amount)))
          : 0) / 1000;
      setBiggestZap(Math.floor(maxZap)); // Already positive
    }
  }, [zaps]); // This effect runs whenever zaps changes

  if (error) {
    return <div className={styles.sentcomponent}>{error}</div>;
  }

  return (
    <div className={styles.sentcomponent}>
      {/* Total Zaps Section */}
      <div className={styles.zapStats}>
        <p className={styles.title}>Total Zaps sent</p>
        <div className={styles.zapsSentContainer}>
          <span className={styles.bigNumber}>
            {zapsSent.totalZaps.toLocaleString()}
          </span>
          <span className={`${styles.sats} ${styles.satsBig}`}> Sats</span>
        </div>
        <div className={styles.zapStats}>
          <table width="100%" className={`${styles.statsTable} `}>
            <tbody>
              <tr>
                <td className={styles.tdWidth}>Average per user</td>
                <td className={`${styles.statValue}`}>
                  {loading ? (
                    'Loading ...'
                  ) : (
                    <>
                      <span className={`${styles.zapValues}`}>
                        {zapsSent.averagePerUser.toLocaleString()}
                      </span>{' '}
                      Sats
                    </>
                  )}
                </td>
              </tr>
              <tr>
                <td>Average per day</td>
                <td className={`${styles.statValue}`}>
                  {loading ? (
                    'Loading ...'
                  ) : (
                    <>
                      <span className={`${styles.zapValues}`}>
                        {zapsSent.averagePerDay.toLocaleString()}
                      </span>{' '}
                      Sats
                    </>
                  )}
                </td>
              </tr>
              <tr>
                <td>Biggest Zap</td>
                <td className={`${styles.statValue}`}>
                  {loading ? (
                    'Loading ...'
                  ) : (
                    <>
                      <span className={`${styles.zapValues}`}>
                        {zapsSent.biggestZap.toLocaleString()}
                      </span>{' '}
                      Sats
                    </>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default TotalZapsComponent;
