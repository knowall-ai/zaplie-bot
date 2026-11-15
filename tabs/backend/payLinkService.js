// The pay link on each person's Allowance wallet, which gives the wallet a
// Lightning address (zaplie-<oid prefix>@<public LNbits host>) for the
// allowance extension to pay into. Zaplie holds no Allowance wallet key since
// the move to NWC: an operator creates the link in LNbits with these values
// (or automatic provisioning does, once) and the address is recorded in the
// directory. These helpers name and shape the link; nothing here calls LNbits.
const { publicLnbitsHost } = require('./lnbitsConfig');

const DESCRIPTION_PREFIX = 'Zaplie allowance';
const MAX_DESCRIPTION_NAME = 80;

/** `zaplie-` plus the first 12 hex digits of the Entra object id. */
const allowanceUsername = (oid) =>
  `zaplie-${String(oid).replace(/-/g, '').toLowerCase().slice(0, 12)}`;

const allowanceDescription = (displayName) => {
  const name = String(displayName || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION_NAME);
  return name ? `${DESCRIPTION_PREFIX} (${name})` : DESCRIPTION_PREFIX;
};

/** The pay link fields Zaplie owns for one person. */
const desiredPayLink = ({ oid, displayName, range }) => ({
  description: allowanceDescription(displayName),
  min: range.minSats,
  max: range.maxSats,
  comment_chars: range.commentChars,
  username: allowanceUsername(oid),
});

/** Zaplie's link among a wallet's links: by username first, then by description. */
const findAllowancePayLink = (links, oid) => {
  const username = allowanceUsername(oid);
  return (
    links.find((link) => link?.username === username) ||
    links.find(
      (link) =>
        typeof link?.description === 'string' &&
        link.description.startsWith(DESCRIPTION_PREFIX),
    ) ||
    null
  );
};

const PAY_LINK_FIELDS = ['description', 'min', 'max', 'comment_chars', 'username'];

/** The fields that differ between an existing link and the desired one. */
const payLinkDiff = (link, desired) =>
  PAY_LINK_FIELDS.filter((field) => {
    if (field === 'min' || field === 'max' || field === 'comment_chars') {
      return Number(link?.[field]) !== Number(desired[field]);
    }
    return (link?.[field] ?? null) !== desired[field];
  });

// lnurlp's PUT replaces the whole link with the request's model, filling
// anything omitted with its defaults, so an update resends the link's own
// settings beside Zaplie's fields.
const PRESERVED_FIELDS = [
  'currency',
  'webhook_url',
  'webhook_headers',
  'webhook_body',
  'success_text',
  'success_url',
  'fiat_base_multiplier',
  'zaps',
  'disposable',
  'domain',
];

const updateBody = (link, desired) => {
  const body = { ...desired };
  for (const field of PRESERVED_FIELDS) {
    if (link[field] !== undefined && link[field] !== null) {
      body[field] = link[field];
    }
  }
  return body;
};

/**
 * Makes sure the wallet has Zaplie's pay link with the desired fields.
 * `wallet` carries the keys and never leaves the server.
 *
 * @returns {{ action: 'noop'|'created'|'updated', link }}
 */
module.exports = {
  DESCRIPTION_PREFIX,
  allowanceDescription,
  allowanceUsername,
  desiredPayLink,
  findAllowancePayLink,
  payLinkDiff,
  publicLnbitsHost,
  updateBody,
};
