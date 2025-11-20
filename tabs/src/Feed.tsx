import React, { useEffect, useState } from 'react';
import FeedComponent from './components/FeedComponent';
import ZapActivityChartComponent from './components/ZapActivityChartComponent';
import TotalZapsComponent from './components/TotalZapsComponent';
import { getUsers, getAllPayments } from './services/lnbitsServiceLocal';
import { useCache } from '../src/utils/CacheContext';
import { fetchAllowanceWalletTransactions } from './utils/walletUtilities';

const Home: React.FC = () => {
  const [timestamp] = useState(() => {
    return Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365 * (8.5 / 12); // Last 8.5 months
  });
  const { cache, setCache } = useCache();
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [zaps, setZaps] = useState<Transaction[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [totalZaps, setTotalZaps] = useState<number>(0);

  const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;

  useEffect(() => {
    const fetchZaps = async () => {
      setLoading(true);
      setError(null);

      try {
        if (!cache['allUsers']) {
          const allUsers = await getUsers(adminKey, {});
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
        if (!cache['allZaps']) {
          const allZaps = await fetchAllowanceWalletTransactions(adminKey);
          console.log('allZaps', allZaps);
          setCache('allZaps', allZaps);
          setZaps(allZaps);
        } else {
          console.log('Loading Zaps from cache:', cache['allZaps']);
          setZaps(cache['allZaps']);
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
  }, [adminKey]); // Only run when adminKey changes, not cache

  return (
    <div style={{ background: '#1F1F1F', paddingBottom: 40 }}>
      <div
        style={{
          width: '100%',
          height: '100%',
          padding: 20,
          //background: '#1F1F1F',
          justifyContent: 'flex-start',
          alignItems: 'flex-start',
          gap: 918,
          display: 'inline-flex',
        }}
      >
        <div
          style={{
            /*height: 246.19,*/
            justifyContent: 'flex-start',
            alignItems: 'flex-start',
            gap: 6,
            display: 'flex',
          }}
        >
          <TotalZapsComponent isLoading={loading} allZaps={zaps} allUsers={users} />
          <ZapActivityChartComponent lnKey={''} isLoading={loading} timestamp={timestamp} allZaps={zaps} allUsers={users} />
        </div>
      </div>
      <div
        style={{
          paddingLeft: 20,
          paddingRight: 20,
          paddingBottom: 20,
          paddingTop: 0,
        }}
      >
        <FeedComponent isLoading={loading} allZaps={zaps} allUsers={users} />
      </div>
    </div>
  );
};

export default Home;
