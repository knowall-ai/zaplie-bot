// Numeric environment variables the bot reads are parsed here, strictly.
//
// This is a deliberate twin of `positiveIntFromEnv` in
// `tabs/backend/rewardAmounts.js`. The bot and the portal backend are separate
// npm packages with no shared module, so the rule is duplicated rather than
// imported — but REWARDS_MAX_AMOUNT_SATS is one variable set once on both apps,
// and it must not be valid for one and malformed for the other. Change both.
//
// `Number()` would accept `1e3`, `0x10` and `10000.0`; none of those is what an
// operator typing a sats ceiling meant, and silently reinterpreting them is how
// a cap ends up somewhere nobody chose.
//
// The fallback may be something other than a number (`null` for "unset means
// none", as LNBITS_INITIAL_ALLOWANCE uses it); the portal twin already takes
// `null` (`positiveIntFromEnv('ZAP_MAX_AMOUNT_SATS', null)` in
// `tabs/backend/lnbitsGatewayService.js`), so this keeps the two at parity.
export function positiveIntFromEnv<F = number>(
  name: string,
  fallback: F,
): number | F {
  const configured = process.env[name];
  if (configured === undefined || configured.trim() === '') {
    return fallback;
  }
  const trimmed = configured.trim();
  const value = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

// Same strict rule, but 0 is allowed: for a setting where 0 means "off"
// (ZAPLIE_LEDGER_STALE_LOCK_MS). Bot-only, so it has no portal twin.
export function nonNegativeIntFromEnv(name: string, fallback: number): number {
  const configured = process.env[name];
  if (configured === undefined || configured.trim() === '') {
    return fallback;
  }
  const trimmed = configured.trim();
  const value = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
