// /me/people ranks by communication frequency across mail, chats and
// meetings without exposing any message content.

export interface RelevantPerson {
  name: string;
  email: string;
}

export async function fetchRelevantPeople(
  accessToken: string,
  top: number,
): Promise<RelevantPerson[]> {
  const params = new URLSearchParams({
    $top: String(top),
    $select: 'displayName,scoredEmailAddresses,personType',
  });

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/people?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph people failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  return (data.value ?? [])
    .filter(
      (person: any) =>
        person?.personType?.class === 'Person' &&
        person?.scoredEmailAddresses?.[0]?.address,
    )
    .map((person: any) => ({
      name: person.displayName,
      email: person.scoredEmailAddresses[0].address,
    }));
}
