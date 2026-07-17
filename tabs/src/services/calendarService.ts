// Client-side Graph calendarView call - no backend involved, uses the signed-in user's own token.

export interface GraphEmailAddress {
  name: string;
  address: string;
}

export interface GraphAttendee {
  emailAddress: GraphEmailAddress;
}

export interface GraphEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  organizer: { emailAddress: GraphEmailAddress };
  attendees: GraphAttendee[];
}

const CALENDAR_VIEW_ENDPOINT = 'https://graph.microsoft.com/v1.0/me/calendarView';

export async function fetchRecentMeetings(
  accessToken: string,
  daysBack: number,
): Promise<GraphEvent[]> {
  const endDateTime = new Date();
  const startDateTime = new Date(endDateTime.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    startDateTime: startDateTime.toISOString(),
    endDateTime: endDateTime.toISOString(),
    $orderby: 'start/dateTime desc',
    $top: '50',
    $select: 'subject,start,end,organizer,attendees',
  });

  const response = await fetch(`${CALENDAR_VIEW_ENDPOINT}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph calendarView failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  return data.value as GraphEvent[];
}
