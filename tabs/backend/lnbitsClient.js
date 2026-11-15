// filepath: tabs/backend/lnbitsClient.js
// The one place this backend talks HTTP to LNbits itself, which is only for
// what is genuinely LNbits: the Fund wallet's allowance extension
// (allowanceExtensionClient.js), the optional rewards store (nostrmarket) and
// the LNbits provisioner (lnbitsProvisioner.js). Wallets Zaplie spends from
// are reached over NWC (nwcWallet.js), never here. Every request carries
// exactly one credential:
//   * `walletKey` - an admin or invoice key, sent as X-Api-Key (unaffected by
//     LNbits' mandatory 2FA), or
//   * `bearer` - a short-lived LNbits ACL token an admin pasted for one
//     provisioning request (lnbitsProvisioner.js). It lives only in that
//     request's memory: never in the environment, a store or a log.
// There is no username/password login and no /users/api/v1 call anywhere.
const { REQUEST_TIMEOUT_MS, lnbitsUrl } = require('./lnbitsConfig');

const { WalletGatewayError } = require('./walletErrors');


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
    throw new WalletGatewayError('LNbits returned a non-JSON response');
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
  if (options.walletKey && options.bearer) {
    throw new WalletGatewayError('an LNbits request carries one credential, not two', 500);
  }
  if (options.walletKey) {
    return { 'X-Api-Key': options.walletKey };
  }
  if (typeof options.bearer === 'string' && options.bearer) {
    return { Authorization: `Bearer ${options.bearer}` };
  }
  // Every LNbits route Zaplie uses is authenticated; an anonymous call is a
  // programming error, not something to send.
  throw new WalletGatewayError('an LNbits request needs a wallet key or a token', 500);
};

/**
 * One LNbits request. Rejects with WalletGatewayError: 400/404 pass through as
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
      throw new WalletGatewayError('LNbits request timed out', 502);
    }
    throw error;
  }

  if (!response.ok) {
    const status =
      response.status === 400 || response.status === 404 ? response.status : 502;
    const error = new WalletGatewayError(
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
  lnbitsRequest,
  maskKeys,
  readErrorDetail,
  redactSensitive,
};
