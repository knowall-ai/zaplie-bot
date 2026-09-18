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

  const renderHeader = (subtitle: React.ReactNode) => (
    <header className={styles.header}>
      <h1 id="week-title" className={styles.title}>
        Your week
      </h1>
      <p className={styles.subtitle}>{subtitle}</p>
    </header>
  );

  const defaultSubtitle = `Your meetings and the people you met in the last ${DAYS_BACK} days.`;

  if (loading) {
    return (
      <div
        className={styles.weekcomponent}
        aria-labelledby="week-title"
        aria-busy="true"
      >
        {renderHeader(defaultSubtitle)}
        <span className={styles.srOnly} role="status">
          Loading your week
        </span>
        <div className={styles.skeletonGroup} aria-hidden="true">
          <div className={`${styles.shimmer} ${styles.skeletonStripCard}`} />
          <div className={`${styles.shimmer} ${styles.skeletonListCard}`} />
        </div>
      </div>
    );
  }

  if (needsConsent) {
    return (
      <div className={styles.weekcomponent} aria-labelledby="week-title">
        {renderHeader(defaultSubtitle)}
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Calendar access needed</h2>
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
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.weekcomponent} aria-labelledby="week-title">
        {renderHeader(defaultSubtitle)}
        <div className={styles.card} role="alert">
          <h2 className={styles.cardTitle}>We couldn&apos;t load your week</h2>
          <p className={styles.stateText}>{error}</p>
          <button
            className={`${styles.button} ${styles.secondaryButton}`}
            onClick={() => setReloadCount(count => count + 1)}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const attendeesToZap = metAttendees.filter(
    a => a.matchedUser && !a.alreadyZapped,
  );
  const onZaplie = metAttendees.filter(a => a.matchedUser);
  const thankedCount = onZaplie.length - attendeesToZap.length;

  const pulseSentence =
    meetings.length === 0
      ? `No meetings in the last ${DAYS_BACK} days.`
      : `You joined ${meetings.length} meeting${
          meetings.length !== 1 ? 's' : ''
        } and met ${metAttendees.length} ${
          metAttendees.length === 1 ? 'person' : 'people'
        } this week${
          attendeesToZap.length > 0
            ? ` — ${attendeesToZap.length} teammate${
                attendeesToZap.length !== 1 ? 's' : ''
              } still to thank.`
            : '.'
        }`;

  // Calendar-style week strip: one column per day that has meetings,
  // oldest day on the left, meetings in chronological order within a day.
  const sortedMeetings = [...meetings].sort(
    (a, b) =>
      asUtc(a.start.dateTime).getTime() - asUtc(b.start.dateTime).getTime(),
  );
  // Calendar band: every consecutive day of the displayed window gets a
  // column, with or without meetings. The window ends today (the component
  // fetches the last DAYS_BACK days), so the last column is today.
  const eventsByDayKey = new Map<string, GraphEvent[]>();
  sortedMeetings.forEach(event => {
    const key = asUtc(event.start.dateTime).toDateString();
    const existing = eventsByDayKey.get(key);
    if (existing) {
      existing.push(event);
    } else {
      eventsByDayKey.set(key, [event]);
    }
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const firstDay = new Date(today);
  firstDay.setDate(firstDay.getDate() - (DAYS_BACK - 1));
  // A meeting fetched at the very edge of the rolling window can fall on the
  // calendar day before the first column; widen the band so nothing is hidden.
  if (sortedMeetings.length > 0) {
    const earliest = asUtc(sortedMeetings[0].start.dateTime);
    earliest.setHours(0, 0, 0, 0);
    while (earliest < firstDay) {
      firstDay.setDate(firstDay.getDate() - 1);
    }
  }
  const calendarDays: Array<{ date: Date; events: GraphEvent[] }> = [];
  for (
    const cursor = new Date(firstDay);
    cursor <= today;
    cursor.setDate(cursor.getDate() + 1)
  ) {
    const date = new Date(cursor);
    calendarDays.push({
      date,
      events: eventsByDayKey.get(date.toDateString()) || [],
    });
  }

  const firstDate = calendarDays[0].date;
  const lastDate = calendarDays[calendarDays.length - 1].date;
  const shortMonth = (d: Date) =>
    d.toLocaleDateString('en-GB', { month: 'short' });
  const rangeLabel =
    firstDate.getMonth() === lastDate.getMonth()
      ? `${firstDate.getDate()}–${lastDate.getDate()} ${shortMonth(lastDate)}`
      : `${firstDate.getDate()} ${shortMonth(firstDate)} – ${lastDate.getDate()} ${shortMonth(lastDate)}`;
  const todayKey = new Date().toDateString();

  const renderPerson = (
    key: string,
    name: string,
    meta: string,
    matchedUser: User | null,
    alreadyZapped: boolean,
  ) => (
    <li key={key} className={styles.row}>
      {renderAvatar(name, matchedUser)}
      <div className={styles.rowInfo}>
        <span className={styles.rowTitle}>{name}</span>
        <span className={styles.rowMeta}>{meta}</span>
      </div>
      {!matchedUser && <span className={styles.rowState}>Not on Zaplie</span>}
      {matchedUser && alreadyZapped && (
        <span className={styles.rowState}>
          Zapped <img src={ZapIcon} alt="" className={styles.inlineIcon} />
        </span>
      )}
      {matchedUser && !alreadyZapped && (
        <button
          className={`${styles.button} ${styles.primaryButton}`}
          onClick={() => setZapTarget(matchedUser)}
        >
          Send a zap
        </button>
      )}
    </li>
  );

  const renderPeopleCard = (
    id: string,
    title: string,
    count: number,
    rows: React.ReactNode,
    footer?: React.ReactNode,
  ) => (
    <section className={styles.card} aria-labelledby={id}>
      <div className={styles.cardHeader}>
        <h2 id={id} className={styles.cardTitle}>
          {title}
        </h2>
        <span className={styles.count}>{count}</span>
      </div>
      {rows}
      {footer}
    </section>
  );

  return (
    <div className={styles.weekcomponent} aria-labelledby="week-title">
      {renderHeader(pulseSentence)}

      <section className={styles.card} aria-labelledby="week-meetings">
        <div className={styles.cardHeader}>
          <h2 id="week-meetings" className={styles.cardTitle}>
            This week&apos;s meetings
          </h2>
          <span className={styles.count}>{meetings.length}</span>
          <span className={styles.rangeLabel}>{rangeLabel}</span>
          {onZaplie.length > 0 && (
            <div className={styles.progressInline}>
              <span className={styles.progressText}>
                {thankedCount} of {onZaplie.length} teammate
                {onZaplie.length !== 1 ? 's' : ''} thanked
              </span>
              <span
                className={styles.progressTrack}
                role="img"
                aria-label={`${thankedCount} of ${onZaplie.length} teammates thanked`}
              >
                <span
                  className={styles.progressFill}
                  style={{
                    width: `${Math.round((thankedCount / onZaplie.length) * 100)}%`,
                  }}
                />
              </span>
            </div>
          )}
        </div>
        {meetings.length === 0 ? (
          <p className={styles.emptyText}>
            No meetings found in the last {DAYS_BACK} days.
          </p>
        ) : (
          <div className={styles.calendarScroll}>
            <ol
              className={styles.calendar}
              style={
                { '--cal-days': calendarDays.length } as React.CSSProperties
              }
            >
              {calendarDays.map(day => {
                const isToday = day.date.toDateString() === todayKey;
                return (
                  <li
                    key={day.date.toDateString()}
                    className={styles.calDay}
                    aria-label={day.date.toLocaleDateString('en-GB', {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                    })}
                  >
                    <div className={styles.calDayHeader}>
                      <span className={styles.calWeekday}>
                        {day.date.toLocaleDateString('en-GB', {
                          weekday: 'short',
                        })}
                      </span>
                      <span
                        className={
                          isToday
                            ? `${styles.calDayNum} ${styles.calDayNumToday}`
                            : styles.calDayNum
                        }
                      >
                        {day.date.getDate()}
                      </span>
                    </div>
                    <ol className={styles.calDayEvents}>
                      {day.events.map(event => {
                        const start = asUtc(event.start.dateTime);
                        return (
                          <li key={event.id} className={styles.meetingChip}>
                            <span className={styles.meetingTime}>
                              {start.toLocaleTimeString('en-GB', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                            <span className={styles.meetingTitle}>
                              {event.subject}
                            </span>
                            <span className={styles.meetingMeta}>
                              {event.attendees.length} attendee
                              {event.attendees.length !== 1 ? 's' : ''}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </section>

      <div className={styles.peopleGrid}>
        {renderPeopleCard(
          'week-people',
          'People you met',
          metAttendees.length,
          metAttendees.length === 0 ? (
            <p className={styles.emptyText}>
              No other attendees in this period.
            </p>
          ) : (
            <ul className={styles.rows}>
              {metAttendees.map(attendee =>
                renderPerson(
                  attendee.email,
                  attendee.name,
                  `Met ${attendee.meetingCount === 1 ? 'once' : `${attendee.meetingCount} times`} · ${attendee.email}`,
                  attendee.matchedUser,
                  attendee.alreadyZapped,
                ),
              )}
            </ul>
          ),
          <>
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
          </>,
        )}

        {collaborators.length > 0 &&
          renderPeopleCard(
            'week-collaborators',
            'People you work with most',
            collaborators.length,
            <ul className={styles.rows}>
              {collaborators.map(person =>
                renderPerson(
                  person.email,
                  person.name,
                  person.email,
                  person.matchedUser,
                  person.alreadyZapped,
                ),
              )}
            </ul>,
          )}
      </div>

      {zapTarget && (
        <SendZapsPopup
          initialUserId={zapTarget.id}
          onClose={() => setZapTarget(null)}
        />
      )}
    </div>
  );
};

export default WeekComponent;
