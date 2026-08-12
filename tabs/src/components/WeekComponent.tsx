import React, { useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import styles from './WeekComponent.module.css';
import { weekScopesRequest } from '../services/authConfig';
import { fetchRecentMeetings, GraphEvent } from '../services/calendarService';
import { fetchRelevantPeople } from '../services/peopleService';
import { fetchZapHistory } from '../services/zapHistoryService';
import SendZapsPopup from './SendZapsPopup';
import ZapIcon from '../images/ZapIcon.svg';
import CalendarIcon from '../images/Calendar.svg';

const DAYS_BACK = 7;

// Graph returns UTC without a 'Z' suffix; append it so the browser renders local time.
const asUtc = (dateTime: string): Date => new Date(`${dateTime}Z`);

const initialsOf = (label: string): string => {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return label.trim().slice(0, 2).toUpperCase();
};

const renderAvatar = (name: string, matchedUser: User | null) =>
  matchedUser?.profileImg ? (
    <img
      className={`${styles.rowMedia} ${styles.avatar}`}
      src={matchedUser.profileImg}
      alt={`${name}'s profile`}
    />
  ) : (
    <div className={`${styles.rowMedia} ${styles.avatarFallback}`}>
      {initialsOf(name)}
    </div>
  );

interface MetAttendee {
  name: string;
  email: string;
  meetingSubject: string;
  meetingCount: number;
  matchedUser: User | null;
  alreadyZapped: boolean;
}

interface CollaboratorRow {
  name: string;
  email: string;
  matchedUser: User | null;
  alreadyZapped: boolean;
}

const WeekComponent: React.FC = () => {
  const { instance, accounts } = useMsal();
  const [meetings, setMeetings] = useState<GraphEvent[]>([]);
  const [metAttendees, setMetAttendees] = useState<MetAttendee[]>([]);
  const [collaborators, setCollaborators] = useState<CollaboratorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [zapTarget, setZapTarget] = useState<User | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    const account = accounts[0];
    if (!account) {
      setLoading(false);
      return;
    }

    const load = async () => {
      setLoading(true);
      setError(null);
      setNeedsConsent(false);

      let accessToken: string;
      let idToken: string;
      try {
        const tokenResponse = await instance.acquireTokenSilent({
          ...weekScopesRequest,
          account,
        });
        accessToken = tokenResponse.accessToken;
        idToken = tokenResponse.idToken;
      } catch (tokenError) {
        if (tokenError instanceof InteractionRequiredAuthError) {
          setNeedsConsent(true);
          setLoading(false);
          return;
        }
        throw tokenError;
      }

      const [events, relevantPeople, { allUsers, zappedUserIds }] =
        await Promise.all([
          fetchRecentMeetings(accessToken, DAYS_BACK),
          fetchRelevantPeople(accessToken, 10),
          fetchZapHistory(
            idToken,
            Math.floor(Date.now() / 1000) - DAYS_BACK * 24 * 60 * 60,
          ),
        ]);
      setMeetings(events);
      const selfEmail = account.username.toLowerCase();

      const attendeeMap = new Map<string, MetAttendee>();
      events.forEach(event => {
        event.attendees
          .filter(a => a.emailAddress.address.toLowerCase() !== selfEmail)
          .forEach(a => {
            const email = a.emailAddress.address.toLowerCase();
            const existing = attendeeMap.get(email);
            if (existing) {
              existing.meetingCount += 1;
              return;
            }
            const matchedUser =
              allUsers.find(u => u.email.toLowerCase() === email) || null;
            attendeeMap.set(email, {
              name: a.emailAddress.name || a.emailAddress.address,
              email: a.emailAddress.address,
              meetingSubject: event.subject,
              meetingCount: 1,
              matchedUser,
              alreadyZapped: matchedUser
                ? zappedUserIds.has(matchedUser.id)
                : false,
            });
          });
      });

      // Unrecognised teammates first, most-met first — the page leads with who to zap
      const rankValue = (a: MetAttendee) =>
        a.matchedUser ? (a.alreadyZapped ? 1 : 2) : 0;
      setMetAttendees(
        Array.from(attendeeMap.values()).sort(
          (a, b) =>
            rankValue(b) - rankValue(a) || b.meetingCount - a.meetingCount,
        ),
      );

      setCollaborators(
        relevantPeople
          .filter(
            p =>
              p.email.toLowerCase() !== selfEmail &&
              !attendeeMap.has(p.email.toLowerCase()),
          )
          .map(p => {
            const matchedUser =
              allUsers.find(
                u => u.email.toLowerCase() === p.email.toLowerCase(),
              ) || null;
            return {
              name: p.name,
              email: p.email,
              matchedUser,
              alreadyZapped: matchedUser
                ? zappedUserIds.has(matchedUser.id)
                : false,
            };
          }),
      );
      setLoading(false);
    };

    load().catch(err => {
      setError(err instanceof Error ? err.message : 'Failed to load your week');
      setLoading(false);
    });
  }, [accounts, instance, reloadCount]);

  const handleGrantAccess = async () => {
    const account = accounts[0];
    if (!account) {
      return;
    }
    try {
      await instance.acquireTokenPopup({ ...weekScopesRequest, account });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Consent was not granted');
      return;
    }
    setError(null);
    setReloadCount(count => count + 1);
  };

  const pageHeader = (
    <header className={styles.header}>
      <span className={styles.eyebrow}>Weekly pulse</span>
      <h1 id="week-title" className={styles.title}>
        Your week
      </h1>
      <p className={styles.subtitle}>
        Recent meetings and the teammates worth recognising.
      </p>
    </header>
  );

  if (loading) {
    return (
      <section
        className={styles.weekcomponent}
        aria-labelledby="week-title"
        aria-busy="true"
      >
        {pageHeader}
        <span className={styles.srOnly} role="status">
          Loading your week
        </span>
        <div className={styles.skeletonStats} aria-hidden="true">
          {[0, 1, 2].map(item => (
            <div
              key={item}
              className={`${styles.shimmer} ${styles.skeletonStat}`}
            />
          ))}
        </div>
        <div className={styles.skeletonList} aria-hidden="true">
          {[0, 1, 2].map(item => (
            <div
              key={item}
              className={`${styles.shimmer} ${styles.skeletonRow}`}
            />
          ))}
        </div>
      </section>
    );
  }

  if (needsConsent) {
    return (
      <section className={styles.weekcomponent} aria-labelledby="week-title">
        {pageHeader}
        <div className={styles.stateCard}>
          <h2 className={styles.stateTitle}>Calendar access needed</h2>
          <p className={styles.stateText}>
            Zaplie needs permission to read your calendar and relevant contacts
            to show recent meetings and the people you work with.
          </p>
          <button
            className={`${styles.button} ${styles.primaryButton}`}
            onClick={handleGrantAccess}
          >
            Grant calendar access
          </button>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={styles.weekcomponent} aria-labelledby="week-title">
        {pageHeader}
        <div className={styles.stateCard} role="alert">
          <h2 className={styles.stateTitle}>We couldn&apos;t load your week</h2>
          <p className={styles.stateText}>{error}</p>
          <button
            className={`${styles.button} ${styles.secondaryButton}`}
            onClick={() => setReloadCount(count => count + 1)}
          >
            Try again
          </button>
        </div>
      </section>
    );
  }

  const attendeesToZap = metAttendees.filter(
    a => a.matchedUser && !a.alreadyZapped,
  );
  const topSuggestion = attendeesToZap[0];
  const onZaplie = metAttendees.filter(a => a.matchedUser);

  const renderPerson = (
    key: string,
    name: string,
    meta: string,
    matchedUser: User | null,
    alreadyZapped: boolean,
  ) => (
    <div key={key} className={styles.row}>
      {renderAvatar(name, matchedUser)}
      <div className={styles.rowInfo}>
        <span className={styles.rowTitle}>{name}</span>
        <span className={styles.rowMeta}>{meta}</span>
      </div>
      {!matchedUser && (
        <span className={styles.noAccountBadge}>Not on Zaplie</span>
      )}
      {matchedUser && alreadyZapped && (
        <span className={styles.zappedBadge}>
          Zapped <img src={ZapIcon} alt="" className={styles.inlineIcon} />
        </span>
      )}
      {matchedUser && !alreadyZapped && (
        <button
          className={`${styles.button} ${styles.primaryButton}`}
          onClick={() => setZapTarget(matchedUser)}
        >
          Zap
        </button>
      )}
    </div>
  );

  return (
    <section className={styles.weekcomponent} aria-labelledby="week-title">
      {pageHeader}

      <div
        className={styles.stats}
        aria-label={`Summary for the last ${DAYS_BACK} days`}
      >
        <div className={styles.stat}>
          <span className={styles.statLabel}>Meetings</span>
          <span className={styles.statNum}>{meetings.length}</span>
          <span className={styles.statHint}>last {DAYS_BACK} days</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>To recognise</span>
          <span className={styles.statNum}>{attendeesToZap.length}</span>
          <span className={styles.statHint}>not zapped yet</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>On Zaplie</span>
          <span className={styles.statNum}>{onZaplie.length}</span>
          <span className={styles.statHint}>of the people you met</span>
        </div>
      </div>

      {topSuggestion && (
        <div className={styles.suggestionRow}>
          <span className={styles.suggestionText}>
            You met <strong>{topSuggestion.name}</strong>{' '}
            {topSuggestion.meetingCount === 1
              ? 'this week'
              : `${topSuggestion.meetingCount} times this week`}{' '}
            and haven't recognised them yet.
          </span>
          <button
            className={`${styles.button} ${styles.primaryButton}`}
            onClick={() => setZapTarget(topSuggestion.matchedUser)}
          >
            Zap {topSuggestion.name.split(' ')[0]}{' '}
            <img src={ZapIcon} alt="" className={styles.inlineIcon} />
          </button>
        </div>
      )}

      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionHeading}>Recent meetings</h2>
        <span className={styles.count}>{meetings.length}</span>
      </div>
      <div className={styles.section}>
        {meetings.length === 0 && (
          <p className={styles.emptyText}>
            No meetings found in the last {DAYS_BACK} days.
          </p>
        )}
        {meetings.map(event => {
          const start = asUtc(event.start.dateTime);
          return (
            <div key={event.id} className={styles.row}>
              <div className={`${styles.rowMedia} ${styles.meetingIcon}`}>
                <img src={CalendarIcon} alt="" className={styles.glyph} />
              </div>
              <div className={styles.rowInfo}>
                <span className={styles.rowTitle}>{event.subject}</span>
                <span className={styles.rowMeta}>
                  {start.toLocaleString('en-GB', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                  {' · '}
                  {event.attendees.length} attendee
                  {event.attendees.length !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionHeading}>People you met</h2>
        <span className={styles.count}>{metAttendees.length}</span>
      </div>
      <div className={styles.section}>
        {metAttendees.length === 0 && (
          <p className={styles.emptyText}>No other attendees in this period.</p>
        )}
        {metAttendees.map(attendee =>
          renderPerson(
            attendee.email,
            attendee.name,
            `Met ${attendee.meetingCount === 1 ? 'once' : `${attendee.meetingCount} times`} · ${attendee.email}`,
            attendee.matchedUser,
            attendee.alreadyZapped,
          ),
        )}
      </div>
      {metAttendees.length > 0 && onZaplie.length === 0 && (
        <p className={styles.summaryText}>
          None of the people you met are on Zaplie yet.
        </p>
      )}
      {onZaplie.length > 0 && attendeesToZap.length === 0 && (
        <p className={styles.summaryText}>
          You have recognised everyone you met this week.
        </p>
      )}

      {collaborators.length > 0 && (
        <>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionHeading}>People you work with most</h2>
            <span className={styles.count}>{collaborators.length}</span>
          </div>
          <div className={styles.section}>
            {collaborators.map(person =>
              renderPerson(
                person.email,
                person.name,
                person.email,
                person.matchedUser,
                person.alreadyZapped,
              ),
            )}
          </div>
        </>
      )}

      {zapTarget && (
        <SendZapsPopup
          initialUserId={zapTarget.id}
          onClose={() => setZapTarget(null)}
        />
      )}
    </section>
  );
};

export default WeekComponent;
