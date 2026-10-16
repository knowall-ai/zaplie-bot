// Who the portal provisions: members of the organisation that runs it, plus
// any guest the organisation has chosen to let in. Nobody else.
//
// This mirrors src/services/memberGate.ts (the bot's rule, from #461) exactly:
// the two packages are separate, so the rules and the allowlist format are
// copied here on purpose and must be kept identical. Change both together.
//
// * a member of this app's own tenant is provisioned;
// * a guest, or a user from another tenant, only when listed in
//   ZAPLIE_GUEST_ALLOWLIST (empty by default);
// * anyone whose membership cannot be determined is refused.
//
// ZAPLIE_GUEST_ALLOWLIST is comma-separated. Each entry is one of:
//   person@example.com   that person, by their sign-in email
//   @example.com         everyone at that email domain
//   <Entra object id>    that person, by their id in this tenant
//
// The bot reads the Teams roster (userRole, tenantId). The portal only has the
// verified idToken, so the same facts come from its claims: `tid` is the
// tenant, and the optional claim `acct` (0 = member, 1 = guest, requested in
// aad.manifest.json) is the role. A token without `acct` cannot be told apart
// from a guest's, so it is refused rather than guessed.

const ALLOWED_USER_ROLE = 'user';

const norm = (value) => String(value ?? '').trim().toLowerCase();

const parseGuestAllowlist = (raw = process.env.ZAPLIE_GUEST_ALLOWLIST) => {
  const list = { emails: new Set(), domains: new Set(), ids: new Set() };
  for (const entry of String(raw ?? '').split(',').map(norm).filter(Boolean)) {
    if (entry.startsWith('@') && entry.length > 1) {
      list.domains.add(entry.slice(1));
    } else if (entry.includes('@')) {
      list.emails.add(entry);
    } else {
      list.ids.add(entry);
    }
  }
  return list;
};

const isAllowlisted = (member, allowlist) => {
  const email = norm(member.email);
  const domain = email.includes('@') ? email.split('@').pop() : '';
  return (
    (email !== '' && allowlist.emails.has(email)) ||
    (domain !== '' && allowlist.domains.has(domain)) ||
    (norm(member.aadObjectId) !== '' && allowlist.ids.has(norm(member.aadObjectId)))
  );
};

// The bot's home tenant setting is AAD_APP_TENANT_ID; the portal backend
// validates tokens against AAD_TENANT_ID. Either names the same tenant.
const homeTenantId = () =>
  process.env.AAD_TENANT_ID || process.env.AAD_APP_TENANT_ID;

const memberVerdict = (
  member,
  home = homeTenantId(),
  allowlist = parseGuestAllowlist(),
) => {
  const homeId = norm(home);
  if (!homeId) {
    return { allowed: false, reason: 'no_tenant_configured' };
  }
  const role = norm(member?.userRole);
  if (role === 'anonymous' || !member) {
    return {
      allowed: false,
      reason: role === 'anonymous' ? 'anonymous' : 'not_a_member',
    };
  }
  if (role === ALLOWED_USER_ROLE && norm(member.tenantId) === homeId) {
    return { allowed: true, via: 'member' };
  }
  if (
    (role === 'guest' || role === ALLOWED_USER_ROLE) &&
    isAllowlisted(member, allowlist)
  ) {
    return { allowed: true, via: 'allowlist' };
  }
  if (role === 'guest') {
    return { allowed: false, reason: 'guest' };
  }
  if (role === ALLOWED_USER_ROLE) {
    return { allowed: false, reason: 'other_tenant' };
  }
  return { allowed: false, reason: 'not_a_member' };
};

// Turns verified idToken claims into the roster shape the rule above reads.
// `acct` is only trustworthy as a number 0 or 1 from the token itself; any
// other shape means the claim was not issued, and the person is refused.
const memberFromTokenClaims = (claims) => {
  if (!claims || typeof claims !== 'object') {
    return null;
  }
  const acct = claims.acct;
  const userRole =
    acct === 0 ? ALLOWED_USER_ROLE : acct === 1 ? 'guest' : undefined;
  if (!userRole) {
    return null;
  }
  return {
    userRole,
    tenantId: typeof claims.tid === 'string' ? claims.tid : undefined,
    email:
      typeof claims.preferred_username === 'string'
        ? claims.preferred_username
        : typeof claims.email === 'string'
          ? claims.email
          : undefined,
    aadObjectId: typeof claims.oid === 'string' ? claims.oid : undefined,
  };
};

const tokenMemberVerdict = (
  claims,
  home = homeTenantId(),
  allowlist = parseGuestAllowlist(),
) => {
  const member = memberFromTokenClaims(claims);
  if (!member) {
    return { allowed: false, reason: 'undeterminable' };
  }
  return memberVerdict(member, home, allowlist);
};

module.exports = {
  ALLOWED_USER_ROLE,
  memberFromTokenClaims,
  memberVerdict,
  parseGuestAllowlist,
  tokenMemberVerdict,
};
