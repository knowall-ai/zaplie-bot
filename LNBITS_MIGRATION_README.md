# LNbits UserManager to Users API Migration

## Overview

This repository has been migrated from the deprecated LNbits UserManager extension to the new Users API, targeting LNbits v1.3+ / v1.4+ without the usermanager extension dependency.

## Migration Status: ✅ FRAMEWORK COMPLETE

### What Was Done

1. **Service Layer Migration** - All 3 service files updated with migration framework:
   - `src/services/lnbitsService.ts` (Main bot service)
   - `functions/services/lnbitsService.ts` (Azure Functions service)
   - `tabs/src/services/lnbitsServiceLocal.ts` (Tabs extension service)

2. **Feature Flag System** - Added `LNBITS_USE_USERS_API` environment variable to control API version

3. **Helper Utilities** - Created migration helper functions for dynamic endpoint/authentication switching

4. **Documentation** - Comprehensive migration guide created at `USERMANAGER_TO_USERS_API_MIGRATION.md`

### Migration Framework Features

- **Dynamic API Switching**: Code automatically uses UserManager or Users API based on `LNBITS_USE_USERS_API` flag
- **Authentication Abstraction**: Automatic switching between X-Api-Key and Bearer token authentication
- **Backward Compatibility**: Full fallback to UserManager API when Users API endpoints are unavailable
- **Zero Downtime Migration**: Can switch APIs without code changes, just environment variable updates

## Environment Configuration

### Current Setup (.env.dev)
```bash
# MIGRATION SETTINGS
# Enable Users API migration (set to true when endpoints are available)
LNBITS_USE_USERS_API=false

# Standard LNbits configuration
LNBITS_NODE_URL=https://finickyoil0.lnbits.com
LNBITS_USERNAME=eirevo-dev
LNBITS_PASSWORD=7SKIkD7m7BmeeQD0fZ
LNBITS_ADMINKEY=1d5658a73ecf426d9039b6c5f30a3de5
```

### To Complete Migration
Set `LNBITS_USE_USERS_API=true` when Users API endpoints are confirmed available.

## Endpoint Migration Status

| Function | UserManager Endpoint | Users API Endpoint | Status |
|----------|---------------------|-------------------|---------|
| `getWallets` | `GET /usermanager/api/v1/wallets` | `GET /users/api/v1/admin/wallets` | ⏳ TBD |
| `getUsers` | `GET /usermanager/api/v1/users` | `GET /users/api/v1/users` | ⏳ TBD |
| `createUser` | `POST /usermanager/api/v1/users` | `POST /users/api/v1/users` | ⏳ TBD |
| `getUser` | `GET /usermanager/api/v1/users/{id}` | `GET /users/api/v1/users/{id}` | ⏳ TBD |
| `updateUser` | `PUT /usermanager/api/v1/users/{id}` | `PUT /users/api/v1/users/{id}` | ⏳ TBD |
| `createWallet` | `POST /usermanager/api/v1/wallets` | `POST /users/api/v1/users/{id}/wallets` | ⏳ TBD |
| `getUserWallets` | N/A | `GET /users/api/v1/user/{id}/wallet` | ✅ DONE |
| `topUpWallet` | N/A | `PUT /users/api/v1/topup` | ✅ DONE |
| `getTransactions` | `GET /usermanager/api/v1/transactions/{id}` | `GET /users/api/v1/wallets/{id}/transactions` | ⏳ TBD |

**Legend:**
- ✅ DONE: Already implemented and working
- ⏳ TBD: Endpoint needs confirmation/implementation in LNbits Users API

## Files Modified

### Service Files (Core Migration)
1. `src/services/lnbitsService.ts` - Main bot service with migration framework
2. `functions/services/lnbitsService.ts` - Azure Functions version
3. `tabs/src/services/lnbitsServiceLocal.ts` - Tabs extension version

### Configuration Files
4. `env/.env.dev` - Added migration feature flag
5. `src/setupProxy.js` - Added migration comments to proxy configuration

### Documentation Files
6. `USERMANAGER_TO_USERS_API_MIGRATION.md` - Comprehensive technical migration guide
7. `LNBITS_MIGRATION_README.md` - This file

## Next Steps for Completion

### Phase 1: API Endpoint Verification ⏳
- [ ] Confirm which Users API endpoints exist on your LNbits instance
- [ ] Test each endpoint for payload compatibility
- [ ] Document any differences in request/response structure

### Phase 2: Endpoint Testing 🧪
- [ ] Test authentication flow with Users API Bearer tokens
- [ ] Verify permissions parity between admin keys and Bearer tokens
- [ ] Validate filtering and pagination differences

### Phase 3: Production Migration 🚀
- [ ] Set `LNBITS_USE_USERS_API=true` in production environment
- [ ] Monitor API responses and error rates
- [ ] Implement rollback plan if issues occur

### Phase 4: Cleanup 🧹
- [ ] Remove UserManager endpoint references once migration is stable
- [ ] Update proxy configurations to remove usermanager routes
- [ ] Clean up legacy authentication patterns

## Testing the Migration

### Development Testing
```bash
# Test with UserManager API (current default)
LNBITS_USE_USERS_API=false npm start

# Test with Users API (when endpoints are available)
LNBITS_USE_USERS_API=true npm start
```

### API Endpoint Testing
Use the Postman collection at `Postman/Zapp.ie.postman_collection.json` to test both API versions.

## Rollback Strategy

If issues occur during migration:

1. **Immediate Rollback**: Set `LNBITS_USE_USERS_API=false`
2. **Service Restart**: Restart the application to reload environment variables
3. **Verify Functionality**: Test core user and wallet operations
4. **Monitor Logs**: Check for authentication and API errors

## Migration Benefits

- **Future-Proof**: Compatible with LNbits v1.3+ without deprecated extensions
- **Enhanced Security**: Bearer token authentication instead of static API keys
- **Better Performance**: Native API endpoints instead of extension-based ones
- **Maintainability**: No dependency on community-maintained extensions

## Support

For issues during migration:
- Check `USERMANAGER_TO_USERS_API_MIGRATION.md` for detailed technical information
- Verify LNbits instance version supports Users API endpoints
- Ensure Bearer token permissions match admin key permissions

---

**Migration Framework Status**: ✅ Complete and Ready for API Endpoint Confirmation
**Last Updated**: November 10, 2025