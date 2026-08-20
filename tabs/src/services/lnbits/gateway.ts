import { loginRequest } from '../authConfig';
import { msalInstance } from '../msalClient';

// LNbits is never reached from the browser: every call below goes to the
// same-origin Express gateway, which holds the credentials server-side.
const API_BASE = '/api/lnbits';

// Long enough for a Lightning payment, short enough that a stalled gateway
// cannot leave a payment caller loading with neither success nor failure.
const REQUEST_TIMEOUT_MS = 30_000;

const getIdToken = async (): Promise<string> => {
  const account =
    msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
  if (!account) {
    throw new Error('Sign in is required');
  }
  const response = await msalInstance.acquireTokenSilent({
    ...loginRequest,
    account,
  });
  if (!response.idToken) {
    throw new Error('Authentication did not return an ID token');
  }
  return response.idToken;
};

export const apiRequest = async <T>(
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const token = await getIdToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the status-only message for a non-JSON response.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
};
