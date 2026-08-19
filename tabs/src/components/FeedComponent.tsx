import { FunctionComponent, lazy, Suspense, useMemo, useState } from 'react';
import styles from './FeedComponent.module.css';
import FeedList from './FeedList';
import { ZapTransfer } from '../utils/walletUtilities';

const Leaderboard = lazy(() => import('./Leaderboard'));

interface FeedComponentProps {
  transfers: ZapTransfer[];
  loading: boolean;
  error: string | null;
}

const FeedComponent: FunctionComponent<FeedComponentProps> = ({
  transfers,
  loading,
  error,
}) => {
  const [activePeriod, setActivePeriod] = useState(7);
  const [showFeed, setShowFeed] = useState(true);
  // Pinned to the period: a timestamp that moved every render would reset the
  // feed back to page one on any interaction.
  const timestamp = useMemo(
    () => Math.floor(Date.now() / 1000 - activePeriod * 24 * 60 * 60),
    [activePeriod],
  );

  return (
    <section className={styles.feedcomponent}>
      <div className={styles.tabs} role="tablist" aria-label="Activity view">
        <button
          type="button"
          role="tab"
          aria-selected={showFeed}
          className={`${styles.stringTabTitle} ${
            showFeed ? styles.active : ''
          }`}
          onClick={() => setShowFeed(true)}
        >
          Feed
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={!showFeed}
          className={`${styles.stringTabTitle} ${
            !showFeed ? styles.active : ''
          }`}
          onClick={() => setShowFeed(false)}
        >
          Leaderboard
        </button>
      </div>
      <div className={styles.pivotPointsdoubleFull60}>
        {[7, 30, 60].map(days => (
          <button
            type="button"
            key={days}
            className={
              activePeriod === days ? styles.daysActive : styles.daysInactive
            }
            aria-pressed={activePeriod === days}
            onClick={() => setActivePeriod(days)}
          >
            {days} days
          </button>
        ))}
      </div>
      {showFeed ? (
        <FeedList
          timestamp={timestamp}
          transfers={transfers}
          loading={loading}
          error={error}
        />
      ) : (
        <Suspense fallback={<p>Loading leaderboard…</p>}>
          <Leaderboard
            timestamp={timestamp}
            transfers={transfers}
            loading={loading}
            error={error}
          />
        </Suspense>
      )}
    </section>
  );
};

export default FeedComponent;
