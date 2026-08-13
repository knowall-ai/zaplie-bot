// Delegated token: Zaplie only reads the chatting user's own work signals.

export interface MeetingAttendee {
  name: string;
  email: string;
}

export interface Meeting {
  subject: string;
  start: string;
  end: string;
  organizer: string;
  attendees: MeetingAttendee[];
  attendeeCount: number;
}

export interface Collaborator {
  name: string;
  email: string;
}

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const MAX_ATTENDEES_PER_MEETING = 20;

interface GraphEvent {
  subject?: string | null;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  organizer?: { emailAddress?: { name?: string } };
  attendees?: Array<{
    emailAddress?: { name?: string; address?: string };
  }>;
}

interface GraphPerson {
  displayName?: string;
  personType?: { class?: string };
  scoredEmailAddresses?: Array<{ address?: string }>;
}

async function graphJson<T>(
  accessToken: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, ...headers },
  });
  if (!response.ok) {
    throw new Error(
      `Microsoft Graph request failed (status: ${response.status}): ${await response.text()}`,
    );
  }
  return response.json();
}

export async function getRecentMeetings(
  accessToken: string,
  days: number,
): Promise<Meeting[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const query = new URLSearchParams({
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
    $orderby: 'start/dateTime desc',
    $top: '50',
    $select: 'subject,start,end,organizer,attendees',
  });
  const data = await graphJson<{ value?: GraphEvent[] }>(
    accessToken,
    `/me/calendarView?${query}`,
    { Prefer: 'outlook.timezone="UTC"' },
  );

  return (data.value ?? []).map(event => ({
    subject: event.subject ?? '(no subject)',
    start: event.start?.dateTime ?? '',
    end: event.end?.dateTime ?? '',
    organizer: event.organizer?.emailAddress?.name ?? '',
    attendees: (event.attendees ?? [])
      .slice(0, MAX_ATTENDEES_PER_MEETING)
      .map(attendee => ({
        name: attendee.emailAddress?.name ?? '',
        email: attendee.emailAddress?.address ?? '',
      })),
    attendeeCount: (event.attendees ?? []).length,
  }));
}

// /me/people ranks by relevance across mail, chats and meetings without
// returning message content.
export async function getRelevantPeople(
  accessToken: string,
  top: number,
): Promise<Collaborator[]> {
  const query = new URLSearchParams({
    $top: String(top),
    $select: 'displayName,scoredEmailAddresses,personType',
  });
  const data = await graphJson<{ value?: GraphPerson[] }>(
    accessToken,
    `/me/people?${query}`,
  );

  return (data.value ?? [])
    .filter(
      person =>
        person?.personType?.class === 'Person' &&
        person?.scoredEmailAddresses?.[0]?.address,
    )
    .map(person => ({
      name: person.displayName ?? '',
      email: person.scoredEmailAddresses[0].address,
    }));
}
