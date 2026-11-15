import { AccountInfo, IPublicClientApplication } from '@azure/msal-browser';
import { loginRequest } from './authConfig';

export const ADMIN_ROLE = 'Zaplie.Admin';

// Entra built-in role template ids (the same in every tenant), carried in
// the idToken's `wids` claim. Mirrors tabs/backend/adminRoles.js, which is
// what actually decides: this only chooses what to show.
export const ROLE_TEMPLATES = {
  globalAdministrator: '62e90394-69f5-4237-9190-012177145e10',
  privilegedRoleAdministrator: 'e8611ab8-c189-46e8-94e1-60213ab1f814',
  cloudApplicationAdministrator: '158c047a-c907-4556-b7ef-446551a6b5f7',
  applicationAdministrator: '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3',
};

type Claims = { roles?: string[]; wids?: string[] } | undefined;
const claimsOf = (account: AccountInfo | undefined) =>
  account?.idTokenClaims as Claims;

const widsOf = (account: AccountInfo | undefined): string[] => {
  const wids = claimsOf(account)?.wids;
  return Array.isArray(wids) ? wids.map(wid => String(wid).toLowerCase()) : [];
};

// The Zaplie.Admin app role (assigned in Entra, usually to the organisation's
// Zaplie Admins group), or Global Administrator of the user's own tenant, so
// an organisation can never lock itself out.
export const isZaplieAdmin = (account: AccountInfo | undefined): boolean => {
  const roles = claimsOf(account)?.roles;
  return (
    (Array.isArray(roles) && roles.includes(ADMIN_ROLE)) ||
    widsOf(account).includes(ROLE_TEMPLATES.globalAdministrator)
  );
};

/** May open "Set up your organisation": Zaplie admins and the IT roles that grant consent. */
export const isSetupAdmin = (account: AccountInfo | undefined): boolean =>
  isZaplieAdmin(account) ||
  widsOf(account).some(wid => Object.values(ROLE_TEMPLATES).includes(wid));

// forceRefresh: acquireTokenSilent can serve a cached, already-expired
// idToken; the backend verifies exp and would reject it with a 401.
export const acquireIdToken = async (
  instance: IPublicClientApplication,
  account: AccountInfo,
): Promise<string> => {
  const tokenResponse = await instance.acquireTokenSilent({
    ...loginRequest,
    account,
    forceRefresh: true,
  });
  return tokenResponse.idToken;
};
