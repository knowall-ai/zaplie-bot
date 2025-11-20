import React, { useEffect, useState,useContext } from 'react';
import ActivityCalendar, { Activity } from 'react-activity-calendar';
import styles from './ZapActivityChartComponent.module.css';
import { RewardNameContext } from './RewardNameContext';

interface ZapContributionsChartProps {
  lnKey: string;
  timestamp: number; // Timestamp in seconds since the epoch
  allZaps: Transaction[];
  allUsers: User[];
  isLoading: boolean;
}

function generateDateRange(fromDate: string, toDate: string): string[] {
  const dates = [];
  const currentDate = new Date(fromDate);
  const endDate = new Date(toDate);

  while (currentDate <= endDate) {
    dates.push(currentDate.toISOString().split('T')[0]);
    currentDate.setDate(currentDate.getDate() + 1);
    console.log('Current date: ', currentDate);
  }

  return dates;
}

const transformZapsToActivities = (
  transactions: Transaction[],
  fromDate: string,
  toDate: string,
): Activity[] => {
  const dateAmounts: { [date: string]: number } = {};

  transactions.forEach(transaction => {
    if (transaction.time) {
      // Handle both Unix timestamp (number) and ISO date string
      let date: string;
      if (typeof transaction.time === 'number') {
        // Unix timestamp in seconds
        date = new Date(transaction.time * 1000).toISOString().split('T')[0];
      } else {
        // ISO date string
        date = new Date(transaction.time).toISOString().split('T')[0];
      }
      const amount = Math.abs(transaction.amount / 1000); // Convert from msats to Sats
      dateAmounts[date] = (dateAmounts[date] || 0) + amount;
    }
  });

  // Generate the full date range
  const dateRange = generateDateRange(fromDate, toDate);

  // Create activities for all dates
  const activities: Activity[] = dateRange.map(date => {
    const totalAmount = dateAmounts[date] || 0;

    let level = 0;
    if (totalAmount > 0 && totalAmount < 1000) {
      level = 1;
    } else if (totalAmount >= 1000 && totalAmount < 2000) {
      level = 2;
    } else if (totalAmount >= 2000 && totalAmount < 3000) {
      level = 3;
    } else if (totalAmount >= 3000) {
      level = 4;
    }
    return { date, count: totalAmount, level };
  });

  console.log('Activities: ', activities);

  return activities;
};

const ZapContributionsChart: React.FC<ZapContributionsChartProps> = ({
  lnKey,
  timestamp,
  allZaps,
  allUsers,
  isLoading,
}) => {
  const [activities, setActivities] = useState<Activity[]>([]);
  useEffect(() => {
        const fetchActivities = async () => {
      try {
        if (allZaps.length === 0) {
          console.log('No transactions available');
          return;
        }

        console.log('Chart transactions: ', allZaps);
        const fromDate = new Date(timestamp * 1000).toISOString().split('T')[0];
        const toDate = new Date().toISOString().split('T')[0];
        const activitiesData = transformZapsToActivities(
          allZaps,
          fromDate,
          toDate,
        );
        setActivities(activitiesData);
        console.log('Activities data: ', activitiesData);
      } catch (error) {
        console.error('Error fetching zaps:', error);
      }
      
    };

    fetchActivities();
  }, [lnKey, timestamp, allZaps]);

   const rewardNameContext = useContext(RewardNameContext);
  if (!rewardNameContext) {
    return null; // or handle the case where the context is not available
  }
const rewardsName = rewardNameContext.rewardName;

  return (
    <div className={styles.zapactivitychartbox}>
      <h2 className={styles.zapactivitycharttitle}>Zap activity</h2>
      {isLoading ? (
        <div style={{ marginLeft: 0, marginRight: 'auto' }}>
          Loading activity data ...
        </div>
      ) : activities.length > 0 ? (
        <ActivityCalendar
          data={activities}
          blockSize={12}
          blockMargin={5}
          fontSize={14}
          theme={{
            dark: ['#1F1F1F', '#492D16', '#BF6C21', '#E56C31', '#F2A900'],
          }}
          colorScheme="dark"
          labels={{
            totalCount: `{{count}} ${rewardsName} zapped (up until yesterday)`,
          }}
        />
      ) : (
        <div style={{ marginLeft: 0, marginRight: 'auto' }}>
          No activity data available
        </div>
      )}
    </div>
  );
};

export default ZapContributionsChart;

