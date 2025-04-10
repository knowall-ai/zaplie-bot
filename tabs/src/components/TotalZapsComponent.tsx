import { FunctionComponent, useState, useEffect, useContext } from 'react';
import styles from './TotalZapsComponent.module.css';
//import lnbitsService from '../services/lnbitsServiceLocal';
/// <reference path = "../global.d.ts" />
import { useCache } from '../utils/CacheContext';
import { RewardNameContext } from './RewardNameContext';
import { getRewardName, updateRewardName } from '../apiService';

export interface ZapSent {
  totalZaps: number;
  numberOfDays: number;
  numberOfUsers: number;
  averagePerUser: number;
  averagePerDay: number;
  biggestZap: number;
  zapsFromCopilots: number;
  zapsToCopilots: number;
}
const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;

interface TotalZapsComponentProps {
  allZaps: Transaction[];
  allUsers: User[];
  isLoading: boolean;
}

const TotalZapsComponent: FunctionComponent<TotalZapsComponentProps> = ({ allZaps, allUsers, isLoading }) => {
  const [zaps, setZaps] = useState<Transaction[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [totalZaps, setTotalZaps] = useState<number>(0);
  const { cache, setCache } = useCache();
  
  const [numberOfDays, setNumberOfDays] = useState<number>(0);
  const [numberOfUsers, setNumberOfUsers] = useState<number>(0);
  const [averagePerDay, setAveragePerDay] = useState<number>(0);
  const [averagePerUser, setAveragePerUser] = useState<number>(0);
  const [biggestZap, setBiggestZap] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const { rewardName, setRewardName } = useContext(RewardNameContext);

  // Get updated Reward Name from context
  useEffect(() => {
    const fetchRewardName = async () => {
      try {
        const data = await getRewardName();
        setRewardName(data.rewardName);
      } catch (error) {
        console.error('Error fetching reward name:', error);
      }
    };

    fetchRewardName();
  }, [setRewardName]);

  const rewardsName = rewardName;

  const zapsSent: ZapSent = {
    totalZaps: totalZaps,
    numberOfDays: numberOfDays,
    numberOfUsers: numberOfUsers,
    averagePerUser: averagePerUser,
    averagePerDay: averagePerDay,
    biggestZap: biggestZap,
    zapsFromCopilots: 0,
    zapsToCopilots: 0,
  };
  
  useEffect(() => {
    setLoading(isLoading);
    if (allZaps.length > 0) {
      console.log('Zaps AKASH: ', allZaps);
      setZaps(allZaps);
    }
    
    //Load users from Cache or paraneter
    console.log('load all users in Total comp', cache['allUsers'] );
    setUsers(allUsers);

    console.log('length:', zaps.length);

    if (zaps.length > 0) {
      console.log('Zaps inside: ', zaps);

      // Calculate the total amount considering only negative values
      const total =
        zaps
          .filter(zap => zap.amount < 0)
          .reduce((sum, zap) => sum + zap.amount, 0) / 1000;
      setTotalZaps(Math.floor(Math.abs(total))); // Convert to positive

      // Calculate the number of users
      const numUsers = users.length;
      setNumberOfUsers(numUsers);

      // Calculate the number of days since the first zap
      const currentTime = Date.now() / 1000;
      const firstZapTime = Math.min(...zaps.map(zap => zap.time));
      const numDays = (currentTime - firstZapTime) / (24 * 60 * 60);
      setNumberOfDays(Math.floor(numDays));

      // Calculate the average per user
      const avPerUser = totalZaps / numUsers;
      setAveragePerUser(Math.floor(Math.abs(avPerUser)));

      // Calculate the average per day
      const avPerDay = Math.abs(total) / Math.floor(numDays);
      setAveragePerDay(Math.floor(Math.abs(avPerDay)));

      // Calculate the biggest zap considering only negative values
      const negativeZaps = zaps.filter(zap => zap.amount < 0);
      const maxZap =
        (negativeZaps.length > 0
          ? Math.max(...negativeZaps.map(zap => Math.abs(zap.amount)))
          : 0) / 1000;
      setBiggestZap(Math.floor(maxZap)); // Already positive
    }
  }, [zaps, users]); // This effect runs whenever zaps changes
  

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
          <span className={`${styles.sats} ${styles.satsBig}`}> {rewardsName}</span>
        </div>
        <div className={styles.zapStats}>
          <table width="100%" className={`${styles.statsTable} `}>
            <tbody>
              <tr>
                <td className={styles.tdWidth}>Number of users</td>
                <td className={`${styles.statValue}`}>
                  {loading ? (
                    'Loading ...'
                  ) : (
                    <>
                      <span className={`${styles.zapValues}`}>
                        {zapsSent.numberOfUsers.toLocaleString()}
                      </span>{' '}
                      Users
                    </>
                  )}
                </td>
              </tr>
              <tr>
                <td className={styles.tdWidth}>Number of days</td>
                <td className={`${styles.statValue}`}>
                  {loading ? (
                    'Loading ...'
                  ) : (
                    <>
                      <span className={`${styles.zapValues}`}>
                        {zapsSent.numberOfDays.toLocaleString()}
                      </span>{' '}
                      Days
                    </>
                  )}
                </td>
              </tr>
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
                      {rewardsName}
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
                      {rewardsName}
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
                      {rewardsName}
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
