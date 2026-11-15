import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

// The person a GitHub id is linked to, by Entra object id: the key of
// Zaplie's people directory (no LNbits user id exists any more).
export interface ResolvedRewardRecipient {
  personAad: string;
}

export async function resolveRewardRecipientByGithubId(
  githubId: string,
): Promise<ResolvedRewardRecipient | null> {
  const response = await fetch(
    `${tabBackendApiUrl()}/identities/resolve?provider=github&providerId=${encodeURIComponent(
      githubId,
    )}`,
    { headers: { Authorization: tabBackendAuthHeader() } },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`identity resolve failed: ${response.status}`);
  }
  const data = await response.json();
  if (typeof data.personAad !== 'string' || data.personAad.length === 0) {
    throw new Error('identity resolve returned an invalid recipient');
  }
  return { personAad: data.personAad };
}
