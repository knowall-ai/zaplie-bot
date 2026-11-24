// filepath: tabs/backend/lnurlPay.js
// Pays a person at their Lightning address (LUD-16 over LUD-06/LUD-12):
// resolve https://<domain>/.well-known/lnurlp/<name>, ask its callback for an
// invoice of the exact amount, and check the invoice really is for that amount
// before anyone pays it.
//
// The address is typed by a user, so every fetch here is a request to a host a
// user chose. Guards: HTTPS only, the domain must be on the allow-list
// (ZAPLIE_LIGHTNING_ADDRESS_DOMAINS, default: the public LNbits host only, so
// allowance sats cannot leave the instance by default), no IP literals, no
// redirects, the callback must stay on the same host, a timeout and a size cap.
const dns = require('dns').promises;
const net = require('net');
const { REQUEST_TIMEOUT_MS, publicLnbitsHost } = require('./lnbitsConfig');

const ADDRESS_PATTERN = /^([a-z0-9._+-]{1,64})@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+)$/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_INVOICE_LENGTH = 4096;

class LnurlPayError extends Error {
  // 4xx messages describe the address and are safe to show the person who
  // typed it; 502s are an upstream failure and stay generic.
  constructor(message, status = 502) {
    super(message);
    this.name = 'LnurlPayError';
    this.status = status;
    this.expose = status < 500;
  }
}

/** The domains a Lightning address may point at. `*` allows any public domain. */
const allowedAddressDomains = (env = process.env) => {
  const configured = String(env.ZAPLIE_LIGHTNING_ADDRESS_DOMAINS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (configured.length > 0) return new Set(configured);
  const host = publicLnbitsHost(env);
  return new Set(host ? [host] : []);
};

/**
 * `{ name, domain, address }` for a well-formed address on an allowed domain;
 * throws LnurlPayError(400) otherwise.
 */
const parseLightningAddress = (value, env = process.env) => {
  const address = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const match = ADDRESS_PATTERN.exec(address);
  if (!match) {
    throw new LnurlPayError('That is not a Lightning address (name@domain).', 400);
  }
  const [, name, domain] = match;
  if (IPV4_PATTERN.test(domain)) {
    throw new LnurlPayError('A Lightning address must use a domain name.', 400);
  }
  const allowed = allowedAddressDomains(env);
  if (!allowed.has('*') && !allowed.has(domain)) {
    throw new LnurlPayError(
      `Lightning addresses on ${domain} are not accepted here. Allowed: ${[...allowed].join(', ') || 'none configured'}.`,
      400,
    );
  }
  return { name, domain, address };
};

const isPrivateAddress = (ip) => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const address = mapped ? mapped[1] : ip;
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const lower = address.toLowerCase();
  return (
    lower === '::' || lower === '::1' ||
    /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff')
  );
};

/**
 * With the `*` wildcard the domain is user-chosen, so refuse any that
 * resolves to a private, loopback or link-local address. A named allow-list
 * is operator-trusted and is not resolved. (Resolve-then-fetch leaves a DNS
 * rebinding window; the callback must still stay on the same host.)
 */
const assertPublicHost = async (domain, env, lookupImpl) => {
  if (!allowedAddressDomains(env).has('*')) return;
  let records;
  try {
    records = await lookupImpl(domain, { all: true });
  } catch (_error) {
    throw new LnurlPayError('The Lightning address could not be reached.');
  }
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    throw new LnurlPayError('A Lightning address must be on a public host.', 400);
  }
};

const fetchJson = async (url, fetchImpl) => {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (_error) {
    throw new LnurlPayError('The Lightning address could not be reached.');
  }
  if (!response.ok) {
    throw new LnurlPayError(
      `The Lightning address answered with status ${response.status}.`,
      response.status === 404 ? 404 : 502,
    );
  }
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new LnurlPayError('The Lightning address sent an oversized response.');
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (_error) {
    throw new LnurlPayError('The Lightning address did not answer with JSON.');
  }
  if (body && String(body.status).toUpperCase() === 'ERROR') {
    throw new LnurlPayError('The Lightning address refused the request.');
  }
  return body;
};

/** The LUD-06 pay parameters behind an address, validated. */
const fetchPayRequest = async (
  value,
  { env = process.env, fetchImpl = fetch, lookupImpl = dns.lookup } = {},
) => {
  const { name, domain, address } = parseLightningAddress(value, env);
  await assertPublicHost(domain, env, lookupImpl);
  const params = await fetchJson(
    `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`,
    fetchImpl,
  );
  if (!params || params.tag !== 'payRequest') {
    throw new LnurlPayError('That Lightning address does not accept payments.', 400);
  }
  let callback;
  try {
    callback = new URL(params.callback);
  } catch (_error) {
    throw new LnurlPayError('The Lightning address sent an invalid callback.');
  }
  if (callback.protocol !== 'https:' || callback.host.toLowerCase() !== domain) {
    throw new LnurlPayError('The Lightning address sent a callback on another host.');
  }
  const minSendable = Number(params.minSendable);
  const maxSendable = Number(params.maxSendable);
  if (!Number.isSafeInteger(minSendable) || !Number.isSafeInteger(maxSendable) || minSendable > maxSendable) {
    throw new LnurlPayError('The Lightning address sent invalid limits.');
  }
  const commentAllowed = Number.isSafeInteger(params.commentAllowed) ? params.commentAllowed : 0;
  return { address, callback, minSendable, maxSendable, commentAllowed };
};

// BOLT 11 amount multipliers, as msat per unit of the human-readable amount.
// 1 BTC = 100,000,000,000 msat; `p` (pico-BTC) is a tenth of a msat.
const MSAT_PER_UNIT = { '': 100000000000n, m: 100000000n, u: 100000n, n: 100n };

/**
 * The amount a BOLT 11 invoice is for, in msat, or null when it carries none.
 * Only the human-readable part is read: this checks a payee's invoice against
 * the amount we asked for, it does not validate the signature (LNbits does).
 */
const bolt11AmountMsat = (invoice) => {
  const text = String(invoice || '').toLowerCase();
  const separator = text.lastIndexOf('1');
  const hrp = separator > 0 ? text.slice(0, separator) : '';
  const match = /^ln[a-z]+?(\d+)([munp]?)$/.exec(hrp);
  if (!match) {
    if (/^ln[a-z]+$/.test(hrp)) return null;
    throw new LnurlPayError('The Lightning address returned an unreadable invoice.');
  }
  const [, digits, multiplier] = match;
  const amount = BigInt(digits);
  if (multiplier === 'p') {
    if (amount % 10n !== 0n) {
      throw new LnurlPayError('The Lightning address returned a sub-millisatoshi invoice.');
    }
    return Number(amount / 10n);
  }
  return Number(amount * MSAT_PER_UNIT[multiplier]);
};

/**
 * An invoice for exactly `amountSats` from the address. Throws LnurlPayError
 * when the amount is outside the address's limits or the invoice it returns
 * is for anything other than what was asked.
 */
const requestInvoice = async (value, amountSats, comment, { env = process.env, fetchImpl = fetch, lookupImpl = dns.lookup } = {}) => {
  const params = await fetchPayRequest(value, { env, fetchImpl, lookupImpl });
  const amountMsat = amountSats * 1000;
  if (!Number.isSafeInteger(amountMsat) || amountMsat < params.minSendable || amountMsat > params.maxSendable) {
    throw new LnurlPayError(
      `${params.address} accepts ${Math.ceil(params.minSendable / 1000)} to ${Math.floor(params.maxSendable / 1000)} sats.`,
      409,
    );
  }
  const callback = new URL(params.callback);
  callback.searchParams.set('amount', String(amountMsat));
  if (params.commentAllowed > 0 && typeof comment === 'string' && comment.trim()) {
    callback.searchParams.set('comment', comment.trim().slice(0, params.commentAllowed));
  }
  const body = await fetchJson(callback.toString(), fetchImpl);
  const pr = body?.pr;
  if (typeof pr !== 'string' || pr.length === 0 || pr.length > MAX_INVOICE_LENGTH || !/^ln[a-z0-9]+$/i.test(pr)) {
    throw new LnurlPayError('The Lightning address did not return an invoice.');
  }
  if (bolt11AmountMsat(pr) !== amountMsat) {
    // Paying it anyway would pay whatever the remote side chose to ask for.
    throw new LnurlPayError('The Lightning address returned an invoice for the wrong amount.');
  }
  return pr;
};

module.exports = {
  LnurlPayError,
  allowedAddressDomains,
  bolt11AmountMsat,
  fetchPayRequest,
  parseLightningAddress,
  requestInvoice,
};
