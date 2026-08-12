import React, { FunctionComponent, useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import styles from './AchievementsSection.module.css';
import { acquireIdToken } from '../services/adminRole';
import {
  Achievement,
  getMyAchievements,
} from '../services/achievementsService';

const AchievementsSection: FunctionComponent = () => {
  const { instance, accounts } = useMsal();
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [earnedCount, setEarnedCount] = useState(0);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accounts[0]) {
      setLoading(false);
      return;
    }
    const load = async () => {
      try {
        const idToken = await acquireIdToken(instance, accounts[0]);
        const result = await getMyAchievements(idToken);
        setAchievements(result.achievements);
        setEarnedCount(result.summary.earnedCount);
      } catch (fetchError) {
        console.error('Error fetching achievements:', fetchError);
        setError(true);
      } finally {
        setLoading(false);
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, instance]);

  if (loading || error || achievements.length === 0) {
    return null;
  }

  return (
    <div className={styles.section}>
      <div className={styles.headingRow}>
        <span className={styles.heading}>Your achievements</span>
        <span className={styles.headingCount}>
          {earnedCount} of {achievements.length} earned
        </span>
      </div>
      <div className={styles.grid}>
        {achievements.map(achievement => {
          const progress = Math.min(
            achievement.current / achievement.target,
            1,
          );
          return (
            <div
              key={achievement.id}
              className={`${styles.card} ${achievement.earned ? styles.cardEarned : ''}`}
            >
              <div
                className={`${styles.medal} ${achievement.earned ? styles.medalEarned : ''}`}
              >
                {achievement.earned ? '✓' : `${Math.floor(progress * 100)}%`}
              </div>
              <div className={styles.cardBody}>
                <span className={styles.cardName}>{achievement.name}</span>
                <span className={styles.cardDescription}>
                  {achievement.description}
                </span>
                {achievement.earned ? (
                  <span className={styles.earnedDate}>
                    Earned{' '}
                    {new Date(
                      achievement.earnedAt as string,
                    ).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                ) : (
                  <div className={styles.progressTrack}>
                    <div
                      className={styles.progressFill}
                      style={{ width: `${progress * 100}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AchievementsSection;
