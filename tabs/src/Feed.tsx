import React, { useEffect, useState } from 'react';
import FeedComponent from './components/FeedComponent';
import ZapActivityChartComponent from './components/ZapActivityChartComponent';
import TotalZapsComponent from './components/TotalZapsComponent';
import { getUsers } from './services/lnbits/users';
import { useCache } from '../src/utils/CacheContext';
import {
  fetchVerifiedZapPayments,
  VerifiedZapPayments,
} from './utils/walletUtilities';

const Home: React.FC = () => {
  const [timestamp] = useState(() => {
    return Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365 * (8.5 / 12); // Last 8.5 months
  });
  const { cache, setCache } = useCache();
  const [loading, setLoading] = useState<boolean>(true);
  const [, setError] = useState<string | null>(null);

  const [zaps, setZaps] = useState<Transaction[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [truncated, setTruncated] = useState<boolean>(false);

  useEffect(() => {
    const fetchZaps = async () => {
      setLoading(true);
      setError(null);

      try {
        if (!cache['allUsers']) {
          const allUsers = await getUsers({});
          console.log('allUsers', allUsers);
          if (allUsers) {
            setCache('allUsers', allUsers);
            setUsers(allUsers);
          }
        } else {
          console.log('Loading Users from cache....');
          setUsers(cache['allUsers']);
        }
      } catch (error) {
        if (error instanceof Error) {
          setError(`Failed to fetch users: ${error.message}`);
        } else {
          setError('An unknown error occurred while fetching users');
        }
        console.error(error);
      }
      // Load zaps and set in cache.
      try {
        // The truncation flag is cached with the payments it describes: a
        // remount that restored the rows but not the warning would present a
        // capped history as the whole story.
        if (!cache['allZaps']) {
          const zapActivity = await fetchVerifiedZapPayments();
          console.log('allZaps', zapActivity.payments);
          setCache('allZaps', zapActivity);
          setZaps(zapActivity.payments);
          setTruncated(zapActivity.truncated);
        } else {
          console.log('Loading Zaps from cache:', cache['allZaps']);
          const cached = cache['allZaps'] as VerifiedZapPayments;
          setZaps(cached.payments);
          setTruncated(cached.truncated);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'An unknown error occurred',
        );
      } finally {
        setLoading(false);
      }
    };

    fetchZaps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // cache and setCache are from context and are stable, intentionally excluded

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
          //background: '#1F1F1F',
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
          {truncated && (
            <div
              role="status"
              style={{ width: '100%', color: '#E0B000', paddingBottom: 8 }}
            >
              History truncated: only the most recent payments could be read, so
              these totals are incomplete.
            </div>
          )}
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
