import { Configuration, PopupRequest } from '@azure/msal-browser';
import { getAppOrigin } from './appLocation';

// Tagged so the startup error UI can tell a missing environment variable
// (safe to show: the message names the variable, never its value) from any
// other failure, whose message may carry detail that does not belong onscreen.
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

const requireConfig = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new ConfigurationError(`${name} is required.`);
  }

  return value;
};

// Built on demand so missing configuration reaches the startup error UI
// instead of throwing while the bundle is still loading.
export const createMsalConfig = (): Configuration => {
  const AADclientid = requireConfig(
    process.env.REACT_APP_AAD_CLIENT_ID,
    'REACT_APP_AAD_CLIENT_ID',
  );
  const TenantId = requireConfig(
    process.env.REACT_APP_TENANT_ID,
    'REACT_APP_TENANT_ID',
  );

  return {
    auth: {
      clientId: AADclientid,
      authority: `https://login.microsoftonline.com/${TenantId}`,
      // The app's origin plus its base path (/portal on getzapl.ie), so each
      // home of this bundle has its own registered redirect URI.
      redirectUri: getAppOrigin(),
      postLogoutRedirectUri: getAppOrigin(),
    },
    system: {
      allowPlatformBroker: false, // Disables WAM Broker
      allowRedirectInIframe: false, // Prevent redirect in iframe
    },
    cache: {
      cacheLocation: 'localStorage', // This can be 'localStorage' or 'sessionStorage'
    },
  };
};

export const loginRequest: PopupRequest = {
  scopes: ['User.Read'],
};
