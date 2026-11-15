import { apiUrl } from '../services/appLocation';

// What went wrong, in terms a person can act on. Used by the error boundary,
// the error pages and any screen that renders a failure.
export type ErrorKind =
  | 'signed-out'
  | 'not-member'
  | 'forbidden'
  | 'wallet-unreachable'
  | 'not-found'
  | 'unknown';

/** An API answer that was not OK, with its HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const classifyError = (error: unknown): ErrorKind => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const status = error instanceof ApiError ? error.status : undefined;
  if (
    status === 401 ||
    /sign in is required|interaction_required|login_required|token.*expired/i.test(
      message,
    )
  ) {
    return 'signed-out';
  }
  if (
    status === 403 &&
    /not a member|organisation|tenant|No Zaplie wallet/i.test(message)
  ) {
    return 'not-member';
  }
  if (status === 403) return 'forbidden';
  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /wallet service is unavailable|timed out|NWC|relay/i.test(message)
  ) {
    return 'wallet-unreachable';
  }
  if (status === 404) return 'not-found';
  return 'unknown';
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A short id a person can quote to support (8 characters, no look-alikes). */
export const newReferenceId = (): string => {
  const bytes = new Uint8Array(8);
  const webCrypto = globalThis.crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, byte => ALPHABET[byte % ALPHABET.length]).join('');
};

/**
 * Tells the backend log about a failure by its reference id, so support can
 * find it. Best effort: never throws, never sends a stack.
 */
export const reportClientError = (report: {
  referenceId: string;
  kind: ErrorKind | 'render';
  route: string;
  message: string;
}): void => {
  try {
    void fetch(apiUrl('/api/client-errors'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        ...report,
        message: report.message.slice(0, 300),
      }),
    }).catch(() => undefined);
  } catch {
    // Reporting must never be the second failure.
  }
};
