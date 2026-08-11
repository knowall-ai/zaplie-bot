import {
  AccountInfo,
  InteractionRequiredAuthError,
  IPublicClientApplication,
} from '@azure/msal-browser';

const getAdminApiScope = (): string => {
  const scope = process.env.REACT_APP_ADMIN_API_SCOPE?.trim();
  if (!scope) {
    throw new Error(
      'REACT_APP_ADMIN_API_SCOPE is required to call the admin configuration API.',
    );
  }
  return scope;
};

export const ADMIN_ROLE = 'Zaplie.Admin';

// This claim check only controls what the portal renders. The backend verifies
// the access token and role again and remains the authorization authority.
export const isZaplieAdmin = (account: AccountInfo | undefined): boolean => {
  const roles = (account?.idTokenClaims as { roles?: string[] } | undefined)?.roles;
  return Array.isArray(roles) && roles.includes(ADMIN_ROLE);
};

export const acquireAdminApiAccessToken = async (
  instance: IPublicClientApplication,
  account: AccountInfo,
): Promise<string> => {
  const request = {
    account,
    scopes: [getAdminApiScope()],
  };

  try {
    const response = await instance.acquireTokenSilent(request);
    return response.accessToken;
  } catch (error) {
    if (!(error instanceof InteractionRequiredAuthError)) {
      throw error;
    }

    const response = await instance.acquireTokenPopup(request);
    return response.accessToken;
  }
};
