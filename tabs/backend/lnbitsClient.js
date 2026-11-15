// filepath: tabs/backend/lnbitsClient.js
// The one place this backend talks HTTP to LNbits. Every request carries
// exactly one credential:
//   * `walletKey` - an admin or invoice key, sent as X-Api-Key (unaffected by
//     LNbits' mandatory 2FA), or
//   * `apiToken: true` - the optional zaplie.service ACL token
//     (LNBITS_API_TOKEN), sent as a Bearer token.
// There is no username/password login and no /users/api/v1 call anywhere.
const { REQUEST_TIMEOUT_MS, lnbitsApiToken, lnbitsUrl } = require('./lnbitsConfig');

class LnbitsGatewayError extends Error {
  // 5xx messages are masked by the router so LNbits internals never reach the
  // browser. `expose` opts a message back in, for the few 5xx cases where the
  // user has to be told something specific rather than "try again".
  constructor(message, status = 502, { expose = false } = {}) {
    super(message);
    this.name = 'LnbitsGatewayError';
    this.status = status;
    this.expose = expose;
  }
}

const SENSITIVE_FIELD = /(adminkey|inkey|admin.?key|invoice.?key|password|preimage|secret|token)/i;

// Anything that looks like an LNbits key (32 hex characters) is masked: an
// error detail must never carry a credential into a log or a run summary.
const KEY_LIKE = /[0-9a-f]{32,}/gi;
const MAX_ERROR_DETAIL = 300;

const maskKeys = (text) => String(text).replace(KEY_LIKE, '[redacted]');

const redactSensitive = (value, depth = 0) => {
  if (depth > 8 || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_FIELD.test(key))
      .map(([key, nested]) => [key, redactSensitive(nested, depth + 1)]),
  );
};

const safeJson = async (response) => {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new LnbitsGatewayError('LNbits returned a non-JSON response');
  }
  return response.json();
};

const readErrorDetail = async (response) => {
  try {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return '';
    }
    const body = await response.json();
    const detail = body && typeof body === 'object' ? body.detail : body;
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail ?? '');
    return maskKeys(text).slice(0, MAX_ERROR_DETAIL);
  } catch (_error) {
    return '';
  }
};

const credentialHeaders = (options) => {
  if (options.walletKey && options.apiToken) {
    throw new LnbitsGatewayError('an LNbits request carries one credential, not two', 500);
  }
  if (options.walletKey) {
    return { 'X-Api-Key': options.walletKey };
  }
  if (options.apiToken) {
    const token = lnbitsApiToken();
    if (!token) {
      throw new LnbitsGatewayError('LNBITS_API_TOKEN is not configured', 503);
    }
    return { Authorization: `Bearer ${token}` };
  }
  // Every LNbits route Zaplie uses is authenticated; an anonymous call is a
  // programming error, not something to send.
  throw new LnbitsGatewayError('an LNbits request needs a wallet key or the API token', 500);
};

/**
 * One LNbits request. Rejects with LnbitsGatewayError: 400/404 pass through as
 * caller mistakes; anything else upstream (including 401/403, which mean our
 * own credential was refused) is a 502. `upstreamStatus` keeps the real code
 * for server-side callers such as the allowance sync.
 */
const lnbitsRequest = async (path, options = {}) => {
  const headers = {
    accept: 'application/json',
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...credentialHeaders(options),
  };

  let response;
  try {
    response = await fetch(`${lnbitsUrl()}${path}`, {
      method: options.method || 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new LnbitsGatewayError('LNbits request timed out', 502);
    }
    throw error;
  }

  if (!response.ok) {
    const status =
      response.status === 400 || response.status === 404 ? response.status : 502;
    const error = new LnbitsGatewayError(
      `LNbits request failed with status ${response.status}`,
      status,
    );
    error.upstreamStatus = response.status;
    if (options.readErrorDetail) {
      error.upstreamDetail = await readErrorDetail(response);
    }
    throw error;
  }
  return safeJson(response);
};

module.exports = {
  LnbitsGatewayError,
  lnbitsRequest,
  maskKeys,
  readErrorDetail,
  redactSensitive,
};
