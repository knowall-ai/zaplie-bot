import { PublicClientApplication } from '@azure/msal-browser';
import { createMsalConfig } from './authConfig';

let instance: PublicClientApplication | undefined;

export const getMsalInstance = (): PublicClientApplication => {
  if (!instance) {
    instance = new PublicClientApplication(createMsalConfig());
  }

  return instance;
};
