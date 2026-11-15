// filepath: tabs/backend/adminRoles.js
// Who may administer an organisation in Zaplie. Entra is the source of truth;
// Zaplie keeps no admin list of its own.
//
//   * Zaplie.Admin app role - assigned in the tenant's Enterprise application
//     (usually to its "Zaplie Admins" group). Scoped by construction: the
//     claim arrives in a token issued by that tenant, and every store a
//     request touches is that tenant's (tenantContext.js).
//   * Global Administrator (wids) - always a Zaplie admin of THEIR tenant,
//     so an organisation can never lock itself out.
//   * Setup (the "Set up your organisation" page): Zaplie admins, plus the IT
//     roles that grant admin consent - Privileged Role Administrator, Cloud
//     Application Administrator, Application Administrator.
//   * Zaplie.PlatformOperator - KnowAll's own support role, honoured only in
//     a token from the platform tenant (tenantConfig.platformTenant), and
//     only for reading another organisation. A customer tenant can create a
//     role of that name; it never counts.
const { normalizeTid, platformTenant } = require('./tenantConfig');

const ADMIN_ROLE = 'Zaplie.Admin';
const PLATFORM_OPERATOR_ROLE = 'Zaplie.PlatformOperator';

// Entra built-in role template ids (the same in every tenant).
const ROLE_TEMPLATES = {
  globalAdministrator: '62e90394-69f5-4237-9190-012177145e10',
  privilegedRoleAdministrator: 'e8611ab8-c189-46e8-94e1-60213ab1f814',
  cloudApplicationAdministrator: '158c047a-c907-4556-b7ef-446551a6b5f7',
  applicationAdministrator: '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3',
};
const SETUP_TEMPLATES = new Set(Object.values(ROLE_TEMPLATES));

const listOf = (value) => (Array.isArray(value) ? value.map((entry) => String(entry).toLowerCase()) : []);

const isGlobalAdministrator = (claims) => listOf(claims?.wids).includes(ROLE_TEMPLATES.globalAdministrator);

/** A Zaplie admin of the token's own tenant. */
const isZaplieAdmin = (claims) =>
  (Array.isArray(claims?.roles) && claims.roles.includes(ADMIN_ROLE)) || isGlobalAdministrator(claims);

/** May use the organisation setup page. */
const isSetupAdmin = (claims) => isZaplieAdmin(claims) || listOf(claims?.wids).some((wid) => SETUP_TEMPLATES.has(wid));

/** KnowAll's support role: only from the platform tenant. */
const isPlatformOperator = (claims, env = process.env) =>
  Array.isArray(claims?.roles) &&
  claims.roles.includes(PLATFORM_OPERATOR_ROLE) &&
  Boolean(platformTenant(env)) &&
  normalizeTid(claims?.tid) === platformTenant(env);

module.exports = {
  ADMIN_ROLE,
  PLATFORM_OPERATOR_ROLE,
  ROLE_TEMPLATES,
  isGlobalAdministrator,
  isPlatformOperator,
  isSetupAdmin,
  isZaplieAdmin,
};
