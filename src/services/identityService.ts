const API_URL = process.env.WEBSITE_API_URL || 'http://localhost:5000/api';

// Placeholder token matches the tab backend's auth (known limitation, issue #171).
export async function resolvePersonAadByGithubId(
  githubId: string,
): Promise<string | null> {
  const response = await fetch(
    `${API_URL}/identities/resolve?provider=github&providerId=${encodeURIComponent(
      githubId,
    )}`,
    { headers: { Authorization: 'your-secret-token' } },
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
