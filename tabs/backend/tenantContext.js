// filepath: tabs/backend/tenantContext.js
// The organisation a request acts for, carried through every await of that
// request (AsyncLocalStorage) so stores resolve their files per tenant
// (dataPaths.js) without each call passing a tenant id along.
//
// Set once per request by tenantMiddleware (server.js), from the verified
// token's `tid` (or, for the bot's shared-token calls, the X-Zaplie-Tenant
// header, which must name an allowed tenant). Anything outside a request
// (the allowance timer, the CLI) runs as the home tenant.
const { AsyncLocalStorage } = require('async_hooks');
const { homeTenant } = require('./tenantConfig');

const storage = new AsyncLocalStorage();

/** The current request's tenant id, else the home tenant (or null). */
const currentTenant = () => storage.getStore()?.tid || homeTenant();

/** Runs `fn` with `tid` as the current tenant. */
const runWithTenant = (tid, fn) => storage.run({ tid }, fn);

module.exports = { currentTenant, runWithTenant };
