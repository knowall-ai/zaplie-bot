# LNbits UserManager to Users API Migration Guide

## Overview
This document provides a comprehensive mapping between the deprecated LNbits UserManager API endpoints and the new Users API endpoints, including authentication patterns, payload structures, and migration strategies for the GetZapl.ie codebase.

## Executive Summary

### Current State
- **Deprecated API**: UserManager API (`/usermanager/api/v1/`)
- **New API**: Users API (`/users/api/v1/`)
- **Authentication Change**: X-Api-Key → Bearer token
- **Scope**: 8 different UserManager endpoints need migration across multiple service files

### Key Findings
1. **Authentication Migration Required**: UserManager uses admin keys via X-Api-Key headers, while Users API uses Bearer tokens via `/api/v1/auth`
2. **Partial Implementation**: Only 2 of the required Users API endpoints are currently implemented
3. **Missing Endpoints**: 6 UserManager functionalities lack Users API equivalents
4. **Payload Compatibility**: Most payload structures can be preserved with minor adjustments

## Endpoint Mapping Analysis

### 1. Get Wallets (Admin Access)

**Current (UserManager)**
```
GET /usermanager/api/v1/wallets
Headers: X-Api-Key: {adminKey}
```

**Target (Users API)**
```
Status: ❌ MISSING ENDPOINT
Proposed: GET /users/api/v1/admin/wallets
Headers: Authorization: Bearer {accessToken}
```

**Files Affected**: 3 service files
- `/src/services/lnbitsService.ts:120`
- `/functions/services/lnbitsService.ts:98`
- `/tabs/src/services/lnbitsServiceLocal.ts:606`

---

### 2. Get User Wallets

**Current (UserManager)**
```
Uses: getWalletById() → getUserWallets() internal pattern
```

**Target (Users API)**
```
Status: ✅ IMPLEMENTED
GET /users/api/v1/user/{userId}/wallet
Headers: Authorization: Bearer {accessToken}
```

**Implementation Status**: Already migrated in codebase

---

### 3. Get Users with Filtering

**Current (UserManager)**
```
GET /usermanager/api/v1/users?extra={encodedExtra}
Headers: X-Api-Key: {adminKey}
Query: extra={"aadObjectId": "...", "userType": "teammate"}
```

**Target (Users API)**
```
Status: ❌ MISSING ENDPOINT
Proposed: GET /users/api/v1/users?filter={encodedFilter}
Headers: Authorization: Bearer {accessToken}
```

**Files Affected**: 3 service files
- `/src/services/lnbitsService.ts:249`
- `/functions/services/lnbitsService.ts:231`
- `/tabs/src/services/lnbitsServiceLocal.ts:268`

---

### 4. Create User

**Current (UserManager)**
```
POST /usermanager/api/v1/users
Headers: X-Api-Key: {adminKey}
Payload: {
  "user_name": string,
  "wallet_name": string,
  "email": string,
  "password": string,
  "extra": {
    "aadObjectId": string,
    "profileImg": string,
    "privateWalletId": string,
    "allowanceWalletId": string,
    "userType": string
  }
}
```

**Target (Users API)**
```
Status: ❌ MISSING ENDPOINT
Proposed: POST /users/api/v1/users
Headers: Authorization: Bearer {accessToken}
Payload: Similar structure with potential field name changes
```

**Files Affected**: 3 service files
- `/src/services/lnbitsService.ts:329`
- `/functions/services/lnbitsService.ts:309`

---

### 5. Get Specific User

**Current (UserManager)**
```
GET /usermanager/api/v1/users/{userId}
Headers: X-Api-Key: {adminKey}
```

**Target (Users API)**
```
Status: ❌ MISSING ENDPOINT
Proposed: GET /users/api/v1/users/{userId}
Headers: Authorization: Bearer {accessToken}
```

**Files Affected**: 3 service files
- `/src/services/lnbitsService.ts:388`
- `/functions/services/lnbitsService.ts:381`
- `/tabs/src/services/lnbitsServiceLocal.ts:338`

---

### 6. Update User

**Current (UserManager)**
```
PUT /usermanager/api/v1/users/{userId}
Headers: X-Api-Key: {adminKey}
Payload: {
  "extra": {
    "aadObjectId": string,
    "privateWalletId": string,
    "allowanceWalletId": string,
    "userType": string
  }
}
```

**Target (Users API)**
```
Status: ❌ MISSING ENDPOINT
Proposed: PUT /users/api/v1/users/{userId}
Headers: Authorization: Bearer {accessToken}
```

**Files Affected**: 1 service file
- `/src/services/lnbitsService.ts:455`

---

### 7. Create Wallet

**Current (UserManager)**
```
POST /usermanager/api/v1/wallets
Headers: X-Api-Key: {adminKey}
Payload: {
  "user_id": string,
  "wallet_name": string
}
```

**Target (Users API)**
```
Status: ❌ MISSING ENDPOINT
Proposed: POST /users/api/v1/users/{userId}/wallets
Headers: Authorization: Bearer {accessToken}
```

**Files Affected**: 3 service files
- `/src/services/lnbitsService.ts:523`
- `/functions/services/lnbitsService.ts:450`

---

### 8. Get Wallet Transactions

**Current (UserManager)**
```
GET /usermanager/api/v1/transactions/{walletId}
Headers: X-Api-Key: {adminKey}
```

**Target (Users API)**
```
Status: ❌ MISSING ENDPOINT
Proposed: GET /users/api/v1/wallets/{walletId}/transactions
Headers: Authorization: Bearer {accessToken}
```

**Files Affected**: 1 service file
- `/tabs/src/services/lnbitsServiceLocal.ts:930`

---

### 9. Top Up Wallet

**Current (Users API)**
```
Status: ✅ ALREADY IMPLEMENTED
PUT /users/api/v1/topup
Headers: Authorization: Bearer {accessToken}
Payload: {
  "amount": string,
  "id": string
}
```

**Implementation Status**: Already migrated and functional

## Authentication Migration Strategy

### Current Pattern (UserManager API)
```javascript
// X-Api-Key authentication
const response = await fetch(`${lnbiturl}/usermanager/api/v1/...`, {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
    'X-Api-Key': adminKey,
  },
});
```

### Target Pattern (Users API)
```javascript
// Bearer token authentication
const accessToken = await getAccessToken(username, password);
const response = await fetch(`${lnbiturl}/users/api/v1/...`, {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  },
});
```

### Token Management
- **Token Acquisition**: Already implemented via `getAccessToken()` function
- **Token Caching**: In-memory caching implemented, localStorage for tabs
- **Token Refresh**: Automatic retry mechanism in place

## Payload Structure Analysis

### User Object Comparison

**UserManager Response**
```json
{
  "id": "string",
  "name": "string",
  "email": "string",
  "extra": {
    "aadObjectId": "string",
    "profileImg": "string",
    "privateWalletId": "string",
    "allowanceWalletId": "string",
    "userType": "string"
  }
}
```

**Users API Response (Expected)**
```json
{
  "id": "string",
  "name": "string",
  "email": "string",
  "extra": {
    "aadObjectId": "string",
    "profileImg": "string",
    "privateWalletId": "string",
    "allowanceWalletId": "string",
    "userType": "string"
  }
}
```

**Internal Application Mapping**
```typescript
interface User {
  id: string;
  displayName: string; // Maps from "name"
  profileImg: string;
  aadObjectId: string; // From extra.aadObjectId
  email: string;
  privateWallet: Wallet | null; // Resolved via getWalletById
  allowanceWallet: Wallet | null; // Resolved via getWalletById
}
```

### Wallet Object Comparison

**Both APIs Return Similar Structure**
```json
{
  "id": "string",
  "admin": "string",
  "name": "string",
  "user": "string",
  "adminkey": "string",
  "inkey": "string",
  "balance_msat": number,
  "deleted": boolean
}
```

## Missing Users API Endpoints

Based on the codebase analysis, the following Users API endpoints need to be implemented or documented:

1. **GET /users/api/v1/admin/wallets** - Get all wallets (admin access)
2. **GET /users/api/v1/users** - Get users with filtering
3. **POST /users/api/v1/users** - Create new user
4. **GET /users/api/v1/users/{userId}** - Get specific user
5. **PUT /users/api/v1/users/{userId}** - Update user
6. **POST /users/api/v1/users/{userId}/wallets** - Create wallet for user
7. **GET /users/api/v1/wallets/{walletId}/transactions** - Get wallet transactions

## Migration Implementation Plan

### Phase 1: API Endpoint Availability ⏳
**Prerequisite**: Confirm Users API endpoint availability
- [ ] Verify which Users API endpoints are available on target LNbits instance
- [ ] Document any differences in payload structure
- [ ] Test authentication flow with Users API

### Phase 2: Service Layer Migration 🔄
**Goal**: Update service methods to use Users API

1. **Update Authentication Pattern**
   ```typescript
   // Replace X-Api-Key with Bearer token pattern
   // Update all UserManager API calls
   ```

2. **Migrate Individual Endpoints**
   - [ ] `getWallets()` - 3 files affected
   - [ ] `getUsers()` - 3 files affected  
   - [ ] `createUser()` - 2 files affected
   - [ ] `getUser()` - 3 files affected
   - [ ] `updateUser()` - 1 file affected
   - [ ] `createWallet()` - 2 files affected
   - [ ] `getTransactions()` - 1 file affected

### Phase 3: Testing & Validation ✅
**Goal**: Ensure feature parity and data integrity

- [ ] Unit tests for each migrated endpoint
- [ ] Integration tests with Users API
- [ ] Performance comparison between APIs
- [ ] Error handling validation

### Phase 4: Deployment & Monitoring 🚀
**Goal**: Safe production deployment

- [ ] Feature flag implementation
- [ ] Gradual rollout strategy
- [ ] API usage monitoring
- [ ] Rollback procedures

## Risk Assessment

### High Risk
- **Missing API Endpoints**: 6 out of 8 endpoints not confirmed in Users API
- **Breaking Changes**: Payload structure differences could break functionality
- **Authentication Failure**: Token-based auth might have different permissions

### Medium Risk
- **Performance Impact**: Bearer token acquisition adds overhead
- **Rate Limiting**: Users API might have different rate limits
- **Cache Invalidation**: Token expiry could cause service interruptions

### Low Risk
- **Code Refactoring**: Well-structured service layer makes changes manageable
- **Rollback**: Existing UserManager implementation can serve as fallback

## Files Requiring Updates

### Service Files (Primary Migration Targets)
1. `/src/services/lnbitsService.ts` - Main service layer
2. `/functions/services/lnbitsService.ts` - Azure Functions service
3. `/tabs/src/services/lnbitsServiceLocal.ts` - Tab extension service

### Configuration Files
4. `/src/setupProxy.js` - Proxy configuration updates
5. `/tabs/src/staticwebapp.config.json` - Static web app routing

### Documentation Files
6. `/Postman/Zapp.ie.postman_collection.json` - API testing collection
7. Environment files - Update endpoint configurations

## Recommendations

### Immediate Actions Required
1. **API Discovery**: Contact LNbits team or check documentation for Users API endpoint availability
2. **Endpoint Testing**: Create test requests for each required Users API endpoint
3. **Permission Mapping**: Verify that Bearer tokens have equivalent permissions to admin keys

### Implementation Strategy
1. **Incremental Migration**: Migrate one endpoint at a time with proper testing
2. **Feature Flags**: Implement toggles to switch between UserManager and Users API
3. **Monitoring**: Add detailed logging during migration to track any issues

### Future Considerations
1. **API Deprecation Timeline**: Plan migration timeline based on UserManager deprecation schedule
2. **Performance Optimization**: Consider caching strategies for Bearer tokens
3. **Error Handling**: Enhance error handling for token-based authentication

## Conclusion

The migration from UserManager API to Users API represents a significant but manageable undertaking. The primary challenges are:

1. **Missing API Endpoints**: 6 out of 8 required endpoints need confirmation
2. **Authentication Overhaul**: Complete shift from key-based to token-based auth
3. **Multi-Service Impact**: Changes required across 3 service implementations

**Success depends on**: Confirming Users API endpoint availability and maintaining feature parity during migration.

**Timeline Estimate**: 2-3 weeks for complete migration, assuming all Users API endpoints are available.