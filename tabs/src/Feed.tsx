import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import FeedComponent from './components/FeedComponent';
import ZapActivityChartComponent from './components/ZapActivityChartComponent';
import TotalZapsComponent from './components/TotalZapsComponent';
import { useCache } from '../src/utils/CacheContext';
import { zapActivityQueryOptions } from './utils/walletUtilities';

const Home: React.FC = () => {
  const [timestamp] = useState(() => {
    return Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365 * (8.5 / 12); // Last 8.5 months
  });
  const { setCache } = useCache();
  const { data: activity, isPending, error, refetch } = useQuery(
    zapActivityQueryOptions(),
  );
  const users = activity?.users ?? [];
  const zaps = useMemo(
    () => activity?.transfers.map(({ transaction }) => transaction) ?? [],
    [activity],
  );

  useEffect(() => {
    if (!activity) return;
    setCache('allUsers', activity.users);
    setCache('allZaps', { payments: zaps, truncated: activity.truncated });
  }, [activity, setCache, zaps]);

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
          {activity?.truncated && (
            <div
              role="status"
              style={{ width: '100%', color: '#E0B000', paddingBottom: 8 }}
            >
              History truncated: only the most recent payments could be read, so
              these totals are incomplete.
            </div>
          )}
          <TotalZapsComponent
            isLoading={isPending}
            allZaps={zaps}
            allUsers={users}
          />
          <ZapActivityChartComponent
            lnKey={''}
            isLoading={isPending}
            timestamp={timestamp}
            allZaps={zaps}
            allUsers={users}
          />
          {error && (
            <div role="alert" style={{ width: '100%' }}>
              <span>
                {error instanceof Error
                  ? error.message
                  : 'Activity could not be loaded.'}
              </span>{' '}
              <button type="button" onClick={() => void refetch()}>
                Try again
              </button>
            </div>
          )}
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
