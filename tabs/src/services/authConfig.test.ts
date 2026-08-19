import { describe, expect, test } from '@jest/globals';
import { createMsalConfig } from './authConfig';

describe('createMsalConfig', () => {
  test('builds the authority from the configured tenant', () => {
    expect(createMsalConfig().auth.authority).toBe(
      `https://login.microsoftonline.com/${process.env.REACT_APP_TENANT_ID}`,
    );
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
