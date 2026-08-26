import React, { useEffect, useState } from 'react';
import FeedComponent from './components/FeedComponent';
import ZapActivityChartComponent from './components/ZapActivityChartComponent';
import TotalZapsComponent from './components/TotalZapsComponent';
import { useCache } from './utils/CacheContext';
import { fetchZapActivity, ZapTransfer } from './utils/walletUtilities';

const Home: React.FC = () => {
  const { setCache } = useCache();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zaps, setZaps] = useState<Transaction[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [transfers, setTransfers] = useState<ZapTransfer[]>([]);
  const [retryToken, setRetryToken] = useState(0);
  const [timestamp] = useState(
    () => Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 259,
  );

  useEffect(() => {
    let active = true;

    const loadFeed = async () => {
      setLoading(true);
      setError(null);

      try {
        const activity = await fetchZapActivity();

        if (!active) return;

        const loadedZaps = activity.transfers.map(item => item.transaction);
        setUsers(activity.users);
        setTransfers(activity.transfers);
        setZaps(loadedZaps);
        setCache('allUsers', activity.users);
        setCache('allZaps', loadedZaps);
      } catch (loadError) {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Feed data is unavailable.',
        );
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadFeed();
    return () => {
      active = false;
    };
  }, [setCache, retryToken]);

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
      {error && (
        <div
          role="alert"
          style={{
            margin: '20px 20px 0',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
            color: '#ffb4ab',
          }}
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setRetryToken(token => token + 1)}
            style={{
              padding: '6px 16px',
              border: '1px solid var(--accent)',
              borderRadius: 'var(--radius-full)',
              background: 'none',
              color: 'var(--accent)',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}
      <div
        style={{
          width: '100%',
          padding: 20,
          display: 'flex',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            width: '100%',
            gap: 6,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'stretch',
          }}
        >
          <TotalZapsComponent
            isLoading={loading}
            allZaps={zaps}
            allUsers={users}
          />
          <ZapActivityChartComponent
            isLoading={loading}
            timestamp={timestamp}
            allZaps={zaps}
          />
        </div>
      </div>
      <div
        style={{
          padding: '0 20px 20px',
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
        }}
      >
        <FeedComponent transfers={transfers} loading={loading} error={error} />
      </div>
    </div>
  );
};

export default Home;
