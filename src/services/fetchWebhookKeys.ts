import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

// Caching means a key revoked in the portal can still verify for up to
// CACHE_TTL_MS (or STALE_MAX_MS if the tab backend is down).
const CACHE_TTL_MS = 30_000;
const STALE_MAX_MS = 5 * 60_000;

let cachedHashes: string[] | null = null;
let cachedAt = 0;
let inflight: Promise<string[]> | null = null;

async function fetchHashes(): Promise<string[]> {
  const response = await fetch(`${tabBackendApiUrl()}/webhook-keys/hashes`, {
    headers: { Authorization: tabBackendAuthHeader() },
  });
  if (!response.ok) {
    throw new Error(`webhook key hashes fetch failed: ${response.status}`);
  }
  const data = await response.json();
  return data.hashes;
}

export async function getWebhookKeyHashes(): Promise<string[]> {
  if (cachedHashes !== null && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedHashes;
  }
  if (!inflight) {
    inflight = fetchHashes().finally(() => {
      inflight = null;
    });
  }
  try {
    const hashes = await inflight;
    cachedHashes = hashes;
    cachedAt = Date.now();
    return hashes;
  } catch (error) {
    if (cachedHashes !== null && Date.now() - cachedAt < STALE_MAX_MS) {
      console.warn(
        'webhook key hashes refresh failed, serving stale cache:',
        error,
      );
      return cachedHashes;
    }
    // No usable cache: fail closed so verification rejects.
    throw error;
  }
}

// Test-only: module-level cache would otherwise leak between tests.
export function resetWebhookKeyHashesCache(): void {
  cachedHashes = null;
  cachedAt = 0;
  inflight = null;
}
