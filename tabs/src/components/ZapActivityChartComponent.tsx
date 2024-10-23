/// <reference path="../types/global.d.ts" />

import React, { useEffect, useState } from 'react';
import ActivityCalendar, { Activity } from 'react-activity-calendar';
import {
  getWalletTransactionsSince,
  getUsers,
  getUserWallets,
} from '../services/lnbitsServiceLocal';
import styles from './ZapActivityChartComponent.module.css';

interface ZapContributionsChartProps {
  lnKey: string;
  timestamp: number; // Timestamp in seconds since the epoch
}

const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;

function generateDateRange(fromDate: string, toDate: string): string[] {
  const dates = [];
  const currentDate = new Date(fromDate);
  const endDate = new Date(toDate);

  while (currentDate <= endDate) {
    dates.push(currentDate.toISOString().split('T')[0]);
    currentDate.setDate(currentDate.getDate() + 1);
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
    if (transaction.time && !isNaN(transaction.time)) {
      const date = new Date(transaction.time * 1000)
        .toISOString()
        .split('T')[0];
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
}) => {
  const [activities, setActivities] = useState<Activity[]>([]);
  //const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const fetchActivities = async () => {
      try {
        let allZaps: Transaction[] = [];
        if (lnKey === '') {
          const users = await getUsers(adminKey, {});
          console.log('Fetching zaps for all users:', users);
          if (users) {
            for (const user of users) {
              const wallets = await getUserWallets(adminKey, user.id);
              console.log('Fetching zaps for all wallets:', wallets);
              if (wallets) {
                const allowanceWallets = wallets.filter(
                  wallet => wallet.name === 'Allowance',
                );

                for (const wallet of allowanceWallets) {
                  const transactions = await getWalletTransactionsSince(
                    wallet.inkey,
                    timestamp,
                    { tag: 'zap' },
                  );
                  allZaps = allZaps.concat(transactions);
                }
              }
            }
          }
        } else {
          console.log('Fetching zaps for wallet:', lnKey);
          console.log('Fetching zaps since:', timestamp);
          allZaps = await getWalletTransactionsSince(lnKey, timestamp, {
            tag: 'zap',
          }); // This currently only gets zaps for the specified wallet.
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
      } catch (error) {
        console.error('Error fetching zaps:', error);
      } finally {
        //setLoading(false);
      }
    };

    fetchActivities();
  }, [lnKey, timestamp]);

  return (
    <div className={styles.zapactivitychartbox}>
      <h2 className={styles.zapactivitycharttitle}>Zap activity</h2>
      {activities.length > 0 ? (
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
            totalCount: '{{count}} Sats zapped (up until yesterday)',
          }}
        />
      ) : (
        <div style={{ marginLeft: 0, marginRight: 'auto' }}>
          Loading activity data ...
        </div>
      )}
    </div>
  );
};

export default ZapContributionsChart;
