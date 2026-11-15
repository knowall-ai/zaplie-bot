// filepath: tabs/backend/tenantRoutes.js
// The organisation's own view of Zaplie:
//   GET /api/tenant/me     who the caller is here (tenant, admin, setup and
//                          platform roles) and the organisation's settings;
//   PUT /api/tenant/setup  "Set up your organisation": the Zaplie Admins group,
//                          the guest allow-list, provisioner defaults. Setup
//                          admins of the caller's own tenant only.
//   GET /api/tenant/platform/tenants  KnowAll's platform operator: every
//                          allowed organisation, read-only.
const express = require('express');
const { verifyMsalClaims, extractBearerToken } = require('./msalValidator');
const { isPlatformOperator, isSetupAdmin, isZaplieAdmin } = require('./adminRoles');
const { allowedTenants, homeTenant } = require('./tenantConfig');
const { currentTenant, runWithTenant } = require('./tenantContext');
const { readTenantSettings, updateTenantSettings } = require('./tenantSettingsStore');
const { peopleStore } = require('./peopleStore');

const createTenantRouter = ({ verifyClaims = verifyMsalClaims } = {}) => {
  const router = express.Router();

  const claimsOf = async (req, res) => {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'missing bearer token' });
      return null;
    }
    try {
      return await verifyClaims(token);
    } catch (error) {
      console.error('MSAL token validation failed:', error.message);
      res.status(401).json({ error: 'invalid token' });
      return null;
    }
  };

  router.get('/me', async (req, res) => {
    const claims = await claimsOf(req, res);
    if (!claims) return;
    const tid = currentTenant();
    res.json({
      tid,
      isHomeTenant: tid === homeTenant(),
      actingAsPlatform: Boolean(req.zaplie?.actingAsPlatform),
      roles: {
        zaplieAdmin: isZaplieAdmin(claims),
        setupAdmin: isSetupAdmin(claims),
        platformOperator: isPlatformOperator(claims),
      },
      clientId: process.env.AAD_CLIENT_ID || null,
      settings: readTenantSettings(),
    });
  });

  router.put('/setup', async (req, res) => {
    const claims = await claimsOf(req, res);
    if (!claims) return;
    if (req.zaplie?.actingAsPlatform || !isSetupAdmin(claims)) {
      res.status(403).json({ error: 'an administrator of this organisation is required' });
      return;
    }
    try {
      res.json({ settings: updateTenantSettings(req.body, { by: claims.oid }) });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.expose ? error.message : 'settings could not be saved' });
    }
  });

  router.get('/platform/tenants', async (req, res) => {
    const claims = await claimsOf(req, res);
    if (!claims) return;
    if (!isPlatformOperator(claims)) {
      res.status(403).json({ error: 'platform operator role required' });
      return;
    }
    const tenants = [];
    for (const tid of allowedTenants()) {
      // Each organisation is read in its own context, so its own files.
      tenants.push(
        await runWithTenant(tid, async () => {
          const people = peopleStore().list();
          const settings = readTenantSettings();
          return {
            tid,
            isHomeTenant: tid === homeTenant(),
            people: people.length,
            withAllowance: people.filter((person) => person.allowance).length,
            adminsGroupConfigured: Boolean(settings.adminsGroupId),
          };
        }),
      );
    }
    res.json({ tenants });
  });

  return router;
};

module.exports = createTenantRouter();
module.exports.createTenantRouter = createTenantRouter;
