import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

export async function resolvePersonAadByGithubId(
  githubId: string,
): Promise<string | null> {
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
  return typeof data.personAad === 'string' ? data.personAad : null;
}
