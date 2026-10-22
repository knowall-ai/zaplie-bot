import { describe, expect, test } from '@jest/globals';
import { createMsalConfig } from './authConfig';

describe('createMsalConfig', () => {
  test('builds the authority from the configured tenant', () => {
    expect(createMsalConfig().auth.authority).toBe(
      `https://login.microsoftonline.com/${process.env.REACT_APP_TENANT_ID}`,
    );
  });

  test('uses the bare origin as the redirect URI at the root', () => {
    const publicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = '';
    try {
      expect(createMsalConfig().auth.redirectUri).toBe(window.location.origin);
    } finally {
      process.env.PUBLIC_URL = publicUrl;
    }
  });

  test('includes the base path in the redirect URIs under /portal/', () => {
    const publicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = '/portal';
    try {
      const { auth } = createMsalConfig();
      expect(auth.redirectUri).toBe(`${window.location.origin}/portal`);
      expect(auth.postLogoutRedirectUri).toBe(
        `${window.location.origin}/portal`,
      );
    } finally {
      process.env.PUBLIC_URL = publicUrl;
    }
  });

  test('throws when the client id is missing', () => {
    const clientId = process.env.REACT_APP_AAD_CLIENT_ID;
    delete process.env.REACT_APP_AAD_CLIENT_ID;

    try {
      expect(() => createMsalConfig()).toThrow(
        'REACT_APP_AAD_CLIENT_ID is required.',
      );
    } finally {
      process.env.REACT_APP_AAD_CLIENT_ID = clientId;
    }
  });
});
