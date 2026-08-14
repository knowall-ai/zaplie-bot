import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

export interface ResolvedRewardRecipient {
  personAad: string;
  lnbitsUserId: string;
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
  if (
    typeof data.personAad !== 'string' ||
    data.personAad.length === 0 ||
    typeof data.lnbitsUserId !== 'string' ||
    data.lnbitsUserId.length === 0
  ) {
    throw new Error('identity resolve returned an invalid recipient');
  }
  return { personAad: data.personAad, lnbitsUserId: data.lnbitsUserId };
}
