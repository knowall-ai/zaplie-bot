// filepath: tabs/backend/tenantConfig.js
// Which Entra tenants (organisations) Zaplie serves, from the environment.
//
// Sign-in stays single-tenant until Ben approves customers: the app
// registration is AzureADMyOrg, and ZAPLIE_ALLOWED_TENANTS defaults to the
// home tenant (AAD_TENANT_ID) only. A token from any tenant not listed is
// refused even when its signature is valid (msalValidator.js). Adding a
// tenant id here, after the registration becomes multi-tenant, is the one
// switch that admits an organisation (docs/MULTI_TENANT.adoc).
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const normalizeTid = (value) => {
  const tid = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return TENANT_ID.test(tid) ? tid : null;
};

/** The tenant this deployment belongs to (KnowAll's), or null when unset. */
const homeTenant = (env = process.env) => normalizeTid(env.AAD_TENANT_ID);

/** Tenants whose tokens are accepted: ZAPLIE_ALLOWED_TENANTS, else the home tenant. */
const allowedTenants = (env = process.env) => {
  const listed = String(env.ZAPLIE_ALLOWED_TENANTS || '')
    .split(',')
    .map(normalizeTid)
    .filter(Boolean);
  const home = homeTenant(env);
  return new Set(listed.length > 0 ? listed : home ? [home] : []);
};

const isAllowedTenant = (tid, env = process.env) => {
  const normalized = normalizeTid(tid);
  return Boolean(normalized && allowedTenants(env).has(normalized));
};

/**
 * The only tenant whose Zaplie.PlatformOperator role is honoured:
 * ZAPLIE_PLATFORM_TENANT_ID, else the home tenant. A customer tenant can
 * assign itself that role name; it never counts there.
 */
const platformTenant = (env = process.env) => normalizeTid(env.ZAPLIE_PLATFORM_TENANT_ID) || homeTenant(env);

module.exports = { allowedTenants, homeTenant, isAllowedTenant, normalizeTid, platformTenant };
