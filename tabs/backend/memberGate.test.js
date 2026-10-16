// The portal's copy of the bot's member rule (src/services/memberGate.ts).
// These cases mirror src/services/fetchUserMiddleware.members.test.ts so a
// drift between the two copies shows up here.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  memberFromTokenClaims,
  memberVerdict,
  parseGuestAllowlist,
  tokenMemberVerdict,
} = require('./memberGate');

const HOME = 'home-tenant';
const allowlist = parseGuestAllowlist(
  ' Guest.OK@partner.test, @friends.test ,allowed-oid, ,',
);

test('the allowlist format is the bot\'s: emails, @domains and object ids', () => {
  assert.deepEqual([...allowlist.emails], ['guest.ok@partner.test']);
  assert.deepEqual([...allowlist.domains], ['friends.test']);
  assert.deepEqual([...allowlist.ids], ['allowed-oid']);
  assert.deepEqual(parseGuestAllowlist(undefined), {
    emails: new Set(),
    domains: new Set(),
    ids: new Set(),
  });
});

test('a member of the home tenant is allowed', () => {
  assert.deepEqual(
    memberVerdict({ userRole: 'user', tenantId: HOME }, HOME, allowlist),
    { allowed: true, via: 'member' },
  );
});

test('a guest is refused unless allowlisted', () => {
  assert.deepEqual(
    memberVerdict({ userRole: 'guest', tenantId: HOME, email: 'x@other.test' }, HOME, allowlist),
    { allowed: false, reason: 'guest' },
  );
  for (const member of [
    { userRole: 'guest', tenantId: HOME, email: 'guest.ok@partner.test' },
    { userRole: 'guest', tenantId: HOME, email: 'anyone@friends.test' },
    { userRole: 'guest', tenantId: HOME, aadObjectId: 'ALLOWED-OID' },
  ]) {
    assert.deepEqual(memberVerdict(member, HOME, allowlist), {
      allowed: true,
      via: 'allowlist',
    });
  }
});

test('a user from another tenant is refused unless allowlisted', () => {
  assert.deepEqual(
    memberVerdict({ userRole: 'user', tenantId: 'elsewhere' }, HOME, allowlist),
    { allowed: false, reason: 'other_tenant' },
  );
  assert.deepEqual(
    memberVerdict({ userRole: 'user', tenantId: 'elsewhere', email: 'guest.ok@partner.test' }, HOME, allowlist),
    { allowed: true, via: 'allowlist' },
  );
});

test('anonymous, roleless and tenant-less configurations are refused', () => {
  assert.deepEqual(memberVerdict({ userRole: 'anonymous' }, HOME, allowlist), {
    allowed: false,
    reason: 'anonymous',
  });
  assert.deepEqual(memberVerdict(null, HOME, allowlist), {
    allowed: false,
    reason: 'not_a_member',
  });
  assert.deepEqual(memberVerdict({ tenantId: HOME, email: 'guest.ok@partner.test' }, HOME, allowlist), {
    allowed: false,
    reason: 'not_a_member',
  });
  assert.deepEqual(memberVerdict({ userRole: 'user', tenantId: HOME }, '', allowlist), {
    allowed: false,
    reason: 'no_tenant_configured',
  });
});

test('token claims map to the roster shape: acct 0 is a member, 1 a guest', () => {
  assert.deepEqual(
    memberFromTokenClaims({ oid: 'oid-1', tid: HOME, acct: 0, preferred_username: 'a@home.test' }),
    { userRole: 'user', tenantId: HOME, email: 'a@home.test', aadObjectId: 'oid-1' },
  );
  assert.equal(memberFromTokenClaims({ oid: 'oid-1', tid: HOME, acct: 1 }).userRole, 'guest');
});

test('a token without a usable acct claim is refused, allowlisted or not', () => {
  for (const claims of [
    { oid: 'allowed-oid', tid: HOME },
    { oid: 'oid-1', tid: HOME, acct: '0' },
    { oid: 'oid-1', tid: HOME, acct: true },
    { oid: 'oid-1', tid: HOME, acct: 2 },
    null,
  ]) {
    assert.deepEqual(tokenMemberVerdict(claims, HOME, allowlist), {
      allowed: false,
      reason: 'undeterminable',
    });
  }
});

test('token verdicts follow the bot\'s rule', () => {
  assert.deepEqual(tokenMemberVerdict({ oid: 'o', tid: HOME, acct: 0 }, HOME, allowlist), {
    allowed: true,
    via: 'member',
  });
  assert.deepEqual(tokenMemberVerdict({ oid: 'o', tid: HOME, acct: 1 }, HOME, allowlist), {
    allowed: false,
    reason: 'guest',
  });
  assert.deepEqual(
    tokenMemberVerdict({ oid: 'o', tid: HOME, acct: 1, preferred_username: 'guest.ok@partner.test' }, HOME, allowlist),
    { allowed: true, via: 'allowlist' },
  );
  assert.deepEqual(tokenMemberVerdict({ oid: 'o', tid: 'elsewhere', acct: 0 }, HOME, allowlist), {
    allowed: false,
    reason: 'other_tenant',
  });
  assert.deepEqual(tokenMemberVerdict({ oid: 'o', acct: 0 }, HOME, allowlist), {
    allowed: false,
    reason: 'other_tenant',
  });
});
