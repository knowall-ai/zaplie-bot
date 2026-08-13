import { AccountInfo, IPublicClientApplication } from '@azure/msal-browser';
import { loginRequest } from './authConfig';

export const ADMIN_ROLE = 'Zaplie.Admin';

// App roles arrive in the idToken's roles claim; assigned per user in Entra.
export const isZaplieAdmin = (account: AccountInfo | undefined): boolean => {
  const roles = (account?.idTokenClaims as { roles?: string[] } | undefined)
    ?.roles;
  return Array.isArray(roles) && roles.includes(ADMIN_ROLE);
};

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
