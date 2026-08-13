import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { getRecentMeetings, getRelevantPeople } from './graphService';

const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch as unknown as typeof fetch;

describe('graphService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('maps calendar events and caps returned attendees', async () => {
    const attendees = Array.from({ length: 25 }, (_, index) => ({
      emailAddress: {
        name: `Person ${index}`,
        address: `p${index}@zaplie.test`,
      },
    }));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        value: [
          {
            subject: 'Sprint review',
            start: { dateTime: 'start' },
            end: { dateTime: 'end' },
            organizer: { emailAddress: { name: 'Grace Hopper' } },
            attendees,
          },
        ],
      }),
    } as Response);

    const [meeting] = await getRecentMeetings('token-1', 7);

    expect(meeting).toMatchObject({
      subject: 'Sprint review',
      organizer: 'Grace Hopper',
      attendeeCount: 25,
    });
    expect(meeting.attendees).toHaveLength(20);
    expect(mockFetch.mock.calls[0][0]).toContain('/me/calendarView?');
  });

  test('tolerates appointments without organizer or attendees', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        value: [{ subject: null, start: {}, end: {} }],
      }),
    } as Response);

    await expect(getRecentMeetings('token-1', 7)).resolves.toEqual([
      {
        subject: '(no subject)',
        start: '',
        end: '',
        organizer: '',
        attendees: [],
        attendeeCount: 0,
      },
    ]);
  });

  test('maps relevant people and drops groups or entries without email', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        value: [
          {
            displayName: 'Ada',
            personType: { class: 'Person' },
            scoredEmailAddresses: [{ address: 'ada@zaplie.test' }],
          },
          {
            displayName: 'Engineering',
            personType: { class: 'Group' },
            scoredEmailAddresses: [{ address: 'eng@zaplie.test' }],
          },
          {
            displayName: 'No Mail',
            personType: { class: 'Person' },
            scoredEmailAddresses: [],
          },
        ],
      }),
    } as Response);

    await expect(getRelevantPeople('token-1', 10)).resolves.toEqual([
      { name: 'Ada', email: 'ada@zaplie.test' },
    ]);
  });

  test('fails loudly when Graph rejects a request', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'insufficient privileges',
    } as Response);

    await expect(getRelevantPeople('token-1', 10)).rejects.toThrow(
      'Microsoft Graph request failed (status: 403): insufficient privileges',
    );
  });
});
