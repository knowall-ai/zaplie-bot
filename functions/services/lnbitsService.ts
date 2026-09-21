import { getCredentials } from './utils';
import { HttpRequest } from '@azure/functions';

let lnbiturl: string | null = null;
let accessToken: string | null = null;
let accessTokenPromise: Promise<string> | null = null;

export function setLnbitUrl(req: HttpRequest): void {
  const { siteUrl } = getCredentials(req);
  lnbiturl = siteUrl ? siteUrl.replace(/\/+$/, '') : null;
}

export function getLnbitUrl(): string | null {
  return lnbiturl;
}

export function resetState(): void {
  lnbiturl = null;
  accessToken = null;
  accessTokenPromise = null;
}

export async function getAccessToken(
  req: HttpRequest,
  username: string,
  password: string,
): Promise<string> {
  if (!lnbiturl) {
    setLnbitUrl(req);
  }
  if (!lnbiturl) {
    throw new Error('LNbits URL is not configured');
  }

  if (accessToken) {
    return accessToken;
  }
  if (accessTokenPromise) {
    return accessTokenPromise;
  }

  accessTokenPromise = (async (): Promise<string> => {
    try {
      const response = await fetch(`${lnbiturl}/api/v1/auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        throw new Error(
          `Error creating access token (status: ${response.status}): ${response.statusText}`,
        );
      }
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Response is not in JSON format');
      }
      const data = (await response.json()) as unknown;
      if (
        !data ||
        typeof data !== 'object' ||
        !('access_token' in data) ||
        typeof (data as { access_token: unknown }).access_token !== 'string' ||
        !(data as { access_token: string }).access_token
      ) {
        throw new Error('Access token is missing in the response');
      }
      accessToken = (data as { access_token: string }).access_token;
      return accessToken;
    } catch (error) {
      console.error('Error in getAccessToken:', error);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      accessTokenPromise = null;
    }
  })();
  return accessTokenPromise;
}

export async function createInvoice(
  req: HttpRequest,
  lnKey: string,
  _recipientWalletId: string,
  amount: number,
  memo: string,
  extra: object,
): Promise<string> {
  if (!lnbiturl) {
    setLnbitUrl(req);
  }
  if (!lnbiturl) {
    throw new Error('LNbits URL is not configured');
  }

  try {
    const response = await fetch(`${lnbiturl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': lnKey,
      },
      body: JSON.stringify({
        out: false,
        amount,
        memo,
        extra,
        unit: 'sat',
      }),
    });

    if (!response.ok) {
      throw new Error(`Error creating an invoice (status: ${response.status})`);
    }

    const data = (await response.json()) as unknown;
    if (
      !data ||
      typeof data !== 'object' ||
      !('payment_request' in data) ||
      typeof (data as { payment_request: unknown }).payment_request !== 'string' ||
      !(data as { payment_request: string }).payment_request
    ) {
      throw new Error('createInvoice: LNbits did not return a valid payment_request');
    }

    return (data as { payment_request: string }).payment_request;
  } catch (error) {
    console.error('createInvoice failed:', error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export interface LnbitsPaymentResult {
  payment_hash: string;
  [key: string]: unknown;
}

export async function payInvoice(
  req: HttpRequest,
  adminKey: string,
  paymentRequest: string,
  extra: object,
): Promise<LnbitsPaymentResult> {
  if (!lnbiturl) {
    setLnbitUrl(req);
  }
  if (!lnbiturl) {
    throw new Error('LNbits URL is not configured');
  }

  try {
    const response = await fetch(`${lnbiturl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': adminKey,
      },
      body: JSON.stringify({
        out: true,
        bolt11: paymentRequest,
        extra,
      }),
    });

    if (!response.ok) {
      throw new Error(`Error paying invoice (status: ${response.status})`);
    }

    const data = (await response.json()) as unknown;
    if (!data || typeof data !== 'object') {
      throw new Error('payInvoice: LNbits did not return a valid payment response');
    }

    return data as LnbitsPaymentResult;
  } catch (error) {
    console.error('payInvoice failed:', error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

// Note: LNbits v1+ core API doesn't provide user details with custom metadata.
// User details must be handled at the application layer.
export async function getUser(
  _req: HttpRequest,
  _userId: string,
  _adminKey: string,
): Promise<never> {
  throw new Error(
    'getUser is not supported by LNbits v1+ core API. Implement user management at application layer.',
  );
}

// Note: LNbits v1+ core API doesn't provide user listing with custom metadata.
// User management with custom metadata must be handled at the application layer.
export async function getUsers(
  _req: HttpRequest,
  _adminKey: string,
  _filterByExtra?: Record<string, string> | { filterByExtra: unknown } | null,
): Promise<never> {
  throw new Error(
    'getUsers is not supported by LNbits v1+ core API. Implement user management at application layer.',
  );
}
