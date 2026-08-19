import React, { useContext, useEffect, useMemo, useState } from 'react';
import { Activity, ActivityCalendar } from 'react-activity-calendar';
import styles from './ZapActivityChartComponent.module.css';
import { RewardNameContext } from './RewardNameContext';

interface ZapContributionsChartProps {
  timestamp: number;
  allZaps: Transaction[];
  isLoading: boolean;
  hasError?: boolean;
}

const toDateKey = (value: number | string): string =>
  new Date(typeof value === 'number' ? value * 1000 : value)
    .toISOString()
    .slice(0, 10);

const buildActivities = (
  transactions: Transaction[],
  fromDate: string,
  toDate: string,
): Activity[] => {
  const totals = transactions.reduce<Record<string, number>>(
    (result, transaction) => {
      if (!transaction.time) return result;
      const date = toDateKey(transaction.time);
      result[date] = (result[date] ?? 0) + Math.abs(transaction.amount) / 1000;
      return result;
    },
    {},
  );
  const activities: Activity[] = [];
  const cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);

  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const count = totals[date] ?? 0;
    const level = count === 0 ? 0 : Math.min(4, Math.ceil(count / 1000));
    activities.push({ date, count, level });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return activities;
};

const ZapContributionsChart: React.FC<ZapContributionsChartProps> = ({
  timestamp,
  allZaps,
  isLoading,
  hasError = false,
}) => {
  const { rewardName } = useContext(RewardNameContext);
  const [compact, setCompact] = useState(
    () => window.matchMedia('(max-width: 600px)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(max-width: 600px)');
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const activities = useMemo(() => {
    const end = new Date().toISOString().slice(0, 10);
    const configuredStart = new Date(timestamp * 1000);
    const compactStart = new Date();
    compactStart.setUTCDate(compactStart.getUTCDate() - 83);
    const start =
      compact && compactStart > configuredStart
        ? compactStart
        : configuredStart;

    return buildActivities(allZaps, start.toISOString().slice(0, 10), end);
  }, [allZaps, compact, timestamp]);

  return (
    <section
      className={styles.zapactivitychartbox}
      aria-busy={isLoading && !hasError}
    >
      <h2 className={styles.zapactivitycharttitle}>Zap activity</h2>
      {hasError ? (
        <p>Activity data is unavailable.</p>
      ) : isLoading ? (
        <p>Loading activity data…</p>
      ) : allZaps.length ? (
        <ActivityCalendar
          data={activities}
          blockSize={compact ? 10 : 12}
          blockMargin={compact ? 3 : 5}
          fontSize={compact ? 12 : 14}
          theme={{
            light: ['#1F1F1F', '#3a5e09', '#4d7a0c', '#6ba513', '#84cc16'],
            dark: ['#1F1F1F', '#3a5e09', '#4d7a0c', '#6ba513', '#84cc16'],
          }}
          labels={{
            totalCount: `{{count}} ${rewardName} zapped${
              compact ? ' in the last 12 weeks' : ''
            }`,
          }}
        />
      ) : (
        <p>No activity data available.</p>
      )}
    </section>
  );
};

export default ZapContributionsChart;
