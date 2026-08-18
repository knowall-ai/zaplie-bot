import { FunctionComponent, useContext, useMemo } from 'react';
import styles from './TotalZapsComponent.module.css';
import { RewardNameContext } from './RewardNameContext';

interface TotalZapsComponentProps {
  allZaps: Transaction[];
  allUsers: User[];
  isLoading: boolean;
  hasError?: boolean;
}

const toSeconds = (time: Transaction['time']): number =>
  typeof time === 'number' ? time : new Date(time).getTime() / 1000;

const TotalZapsComponent: FunctionComponent<TotalZapsComponentProps> = ({
  allZaps,
  allUsers,
  isLoading,
  hasError = false,
}) => {
  const { rewardName } = useContext(RewardNameContext);
  const stats = useMemo(() => {
    const sent = allZaps.filter(zap => zap.amount < 0);
    const amounts = sent.map(zap => Math.abs(zap.amount) / 1000);
    const total = amounts.reduce((sum, amount) => sum + amount, 0);
    const validTimes = sent
      .map(zap => toSeconds(zap.time))
      .filter(Number.isFinite);
    const days = validTimes.length
      ? Math.max(
          1,
          Math.ceil(
            (Date.now() / 1000 - Math.min(...validTimes)) / (24 * 60 * 60),
          ),
        )
      : 0;
    const users = allUsers.length;

    return {
      total: Math.floor(total),
      users,
      days,
      averagePerUser: users ? Math.floor(total / users) : 0,
      averagePerDay: days ? Math.floor(total / days) : 0,
      biggest: amounts.length ? Math.floor(Math.max(...amounts)) : 0,
    };
  }, [allUsers.length, allZaps]);

  const value = (amount: number) =>
    hasError ? 'Unavailable' : isLoading ? 'Loading…' : amount.toLocaleString();

  return (
    <section className={styles.sentcomponent} aria-busy={isLoading}>
      <h2 className={styles.title}>Total Zaps sent</h2>
      <div className={styles.zapsSentContainer}>
        <span className={styles.bigNumber}>{value(stats.total)}</span>
        {!isLoading && !hasError && (
          <span className={styles.sats}>{rewardName}</span>
        )}
      </div>
      <dl className={styles.statsList}>
        <div>
          <dt>Number of users</dt>
          <dd>{value(stats.users)}</dd>
        </div>
        <div>
          <dt>Number of days</dt>
          <dd>{value(stats.days)}</dd>
        </div>
        <div>
          <dt>Average per user</dt>
          <dd>
            {value(stats.averagePerUser)} {!isLoading && rewardName}
          </dd>
        </div>
        <div>
          <dt>Average per day</dt>
          <dd>
            {value(stats.averagePerDay)} {!isLoading && rewardName}
          </dd>
        </div>
        <div>
          <dt>Biggest Zap</dt>
          <dd>
            {value(stats.biggest)} {!isLoading && rewardName}
          </dd>
        </div>
      </dl>
    </section>
  );
};

export default TotalZapsComponent;
