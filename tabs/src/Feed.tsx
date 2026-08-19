import React, { useEffect, useState } from 'react';
import FeedComponent from './components/FeedComponent';
import ZapActivityChartComponent from './components/ZapActivityChartComponent';
import TotalZapsComponent from './components/TotalZapsComponent';
import { getUsers } from './services/lnbitsServiceLocal';
import { useCache } from '../src/utils/CacheContext';
import { fetchAllowanceWalletTransactions } from './utils/walletUtilities';

const ACTIVITY_HISTORY_MONTHS = 8.5;

const Home: React.FC = () => {
  const [timestamp] = useState(() => {
    return (
      Math.floor(Date.now() / 1000) -
      60 * 60 * 24 * 365 * (ACTIVITY_HISTORY_MONTHS / 12)
    );
  });
  const { cache, setCache } = useCache();
  const [loading, setLoading] = useState<boolean>(true);
  const [, setError] = useState<string | null>(null);

  const [zaps, setZaps] = useState<Transaction[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    const fetchZaps = async () => {
      setLoading(true);
      setError(null);

      try {
        const cachedUsers = cache['allUsers'];
        if (!Array.isArray(cachedUsers)) {
          const allUsers = await getUsers({});
          setCache('allUsers', allUsers);
          setUsers(allUsers);
        } else {
          setUsers(cachedUsers as User[]);
        }
      } catch (error) {
        if (error instanceof Error) {
          setError(`Failed to fetch users: ${error.message}`);
        } else {
          setError('An unknown error occurred while fetching users');
        }
      }

      try {
        const cachedZaps = cache['allZaps'];
        if (!Array.isArray(cachedZaps)) {
          const allZaps = await fetchAllowanceWalletTransactions();
          setCache('allZaps', allZaps);
          setZaps(allZaps);
        } else {
          setZaps(cachedZaps as Transaction[]);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'An unknown error occurred',
        );
      } finally {
        setLoading(false);
      }
    };

    void fetchZaps();
  }, [cache, setCache]);

  return (
    <div
      style={{
        background: '#1F1F1F',
        paddingBottom: 40,
        width: '100%',
        minWidth: 0,
        alignSelf: 'stretch',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          padding: 20,
          justifyContent: 'flex-start',
          alignItems: 'flex-start',
          display: 'flex',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            width: '100%',
            justifyContent: 'flex-start',
            alignItems: 'stretch',
            gap: 6,
            display: 'flex',
            flexWrap: 'wrap',
          }}
        >
          <TotalZapsComponent
            isLoading={loading}
            allZaps={zaps}
            allUsers={users}
          />
          <ZapActivityChartComponent
            lnKey={''}
            isLoading={loading}
            timestamp={timestamp}
            allZaps={zaps}
            allUsers={users}
          />
        </div>
      </div>
      <div
        style={{
          paddingLeft: 20,
          paddingRight: 20,
          paddingBottom: 20,
          paddingTop: 0,
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
          overflowX: 'auto',
        }}
      >
        <FeedComponent />
      </div>
    </div>
  );
};

export default Home;
