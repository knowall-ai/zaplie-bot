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

const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;
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
    <img className={styles.avatar} src={matchedUser.profileImg} alt="" />
  ) : (
    <div className={styles.avatarFallback}>{initialsOf(name)}</div>
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
      try {
        const tokenResponse = await instance.acquireTokenSilent({ ...weekScopesRequest, account });
        accessToken = tokenResponse.accessToken;
      } catch (tokenError) {
        if (tokenError instanceof InteractionRequiredAuthError) {
          setNeedsConsent(true);
          setLoading(false);
          return;
        }
        throw tokenError;
      }

      const [events, relevantPeople, { allUsers, zappedUserIds }] = await Promise.all([
        fetchRecentMeetings(accessToken, DAYS_BACK),
        fetchRelevantPeople(accessToken, 10),
        fetchZapHistory(
          adminKey,
          account.localAccountId,
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
            const matchedUser = allUsers.find(u => u.email.toLowerCase() === email) || null;
            attendeeMap.set(email, {
              name: a.emailAddress.name || a.emailAddress.address,
              email: a.emailAddress.address,
              meetingSubject: event.subject,
              meetingCount: 1,
              matchedUser,
              alreadyZapped: matchedUser ? zappedUserIds.has(matchedUser.id) : false,
            });
          });
      });

      // Unrecognised teammates first, most-met first — the page leads with who to zap
      const rankValue = (a: MetAttendee) =>
        a.matchedUser ? (a.alreadyZapped ? 1 : 2) : 0;
      setMetAttendees(
        Array.from(attendeeMap.values()).sort(
          (a, b) => rankValue(b) - rankValue(a) || b.meetingCount - a.meetingCount,
        ),
      );

      setCollaborators(
        relevantPeople
          .filter(p => p.email.toLowerCase() !== selfEmail && !attendeeMap.has(p.email.toLowerCase()))
          .map(p => {
            const matchedUser = allUsers.find(u => u.email.toLowerCase() === p.email.toLowerCase()) || null;
            return {
              name: p.name,
              email: p.email,
              matchedUser,
              alreadyZapped: matchedUser ? zappedUserIds.has(matchedUser.id) : false,
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

  if (loading) {
    return <div className={styles.weekcomponent}><p className={styles.subtitle}>Loading your week...</p></div>;
  }

  if (needsConsent) {
    return (
      <div className={styles.weekcomponent}>
        <h2 className={styles.title}>Your week</h2>
        <div className={styles.consentBox}>
          <p className={styles.subtitle}>
            Zaplie needs permission to read your calendar and relevant contacts to show recent meetings and the people you work with.
          </p>
          <button className={styles.consentButton} onClick={handleGrantAccess}>
            Grant calendar access
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return <div className={styles.weekcomponent}><p className={styles.errorText}>{error}</p></div>;
  }

  const attendeesToZap = metAttendees.filter(a => a.matchedUser && !a.alreadyZapped);
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
      {!matchedUser && <span className={styles.noAccountBadge}>Not on Zaplie</span>}
      {matchedUser && alreadyZapped && (
        <span className={styles.zappedBadge}>
          Zapped <img src={ZapIcon} alt="" className={styles.inlineIcon} />
        </span>
      )}
      {matchedUser && !alreadyZapped && (
        <button className={styles.zapButton} onClick={() => setZapTarget(matchedUser)}>
          Zap
        </button>
      )}
    </div>
  );

  return (
    <div className={styles.weekcomponent}>
      <h2 className={styles.title}>Your week</h2>
      <p className={styles.subtitle}>Meetings from the last {DAYS_BACK} days, and teammates worth recognising.</p>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statNum}>{meetings.length}</span>
          <span className={styles.statLabel}>meetings</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statNum}>{attendeesToZap.length}</span>
          <span className={styles.statLabel}>to recognise</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statNum}>{onZaplie.length}</span>
          <span className={styles.statLabel}>on Zaplie</span>
        </div>
      </div>

      {topSuggestion && (
        <div className={styles.suggestionRow}>
          <span className={styles.suggestionText}>
            You met <strong>{topSuggestion.name}</strong>{' '}
            {topSuggestion.meetingCount === 1 ? 'this week' : `${topSuggestion.meetingCount} times this week`}{' '}
            and haven't recognised them yet.
          </span>
          <button className={styles.zapButton} onClick={() => setZapTarget(topSuggestion.matchedUser)}>
            Zap {topSuggestion.name.split(' ')[0]} <img src={ZapIcon} alt="" className={styles.inlineIcon} />
          </button>
        </div>
      )}

      <h3 className={styles.sectionHeading}>Recent meetings ({meetings.length})</h3>
      {meetings.length === 0 && <p className={styles.emptyText}>No meetings found in this period.</p>}
      <div className={styles.section}>
        {meetings.map(event => {
          const start = asUtc(event.start.dateTime);
          return (
            <div key={event.id} className={styles.row}>
              <div className={styles.meetingIcon}>
                <img src={CalendarIcon} alt="" className={styles.glyph} />
              </div>
              <div className={styles.rowInfo}>
                <span className={styles.rowTitle}>{event.subject}</span>
                <span className={styles.rowMeta}>
                  {start.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                  {' · '}{event.attendees.length} attendee{event.attendees.length !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <h3 className={styles.sectionHeading}>People you met ({metAttendees.length})</h3>
      {metAttendees.length === 0 && <p className={styles.emptyText}>No other attendees in this period.</p>}
      <div className={styles.section}>
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
        <p className={styles.emptyText}>None of the people you met are on Zaplie yet.</p>
      )}
      {onZaplie.length > 0 && attendeesToZap.length === 0 && (
        <p className={styles.emptyText}>You have recognised everyone you met this week.</p>
      )}

      {collaborators.length > 0 && (
        <>
          <h3 className={styles.sectionHeading}>People you work with most</h3>
          <div className={styles.section}>
            {collaborators.map(person =>
              renderPerson(person.email, person.name, person.email, person.matchedUser, person.alreadyZapped),
            )}
          </div>
        </>
      )}

      {zapTarget && (
        <SendZapsPopup initialUserId={zapTarget.id} onClose={() => setZapTarget(null)} />
      )}
    </div>
  );
};

export default WeekComponent;
