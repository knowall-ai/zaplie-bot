import { afterAll, beforeEach, describe, expect, test } from '@jest/globals';
import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

const originalToken = process.env.TAB_BACKEND_TOKEN;
const originalApiUrl = process.env.WEBSITE_API_URL;
const originalNodeEnv = process.env.NODE_ENV;

describe('tabBackendAuthHeader', () => {
  beforeEach(() => {
    delete process.env.TAB_BACKEND_TOKEN;
    delete process.env.WEBSITE_API_URL;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    if (originalToken === undefined) {
      delete process.env.TAB_BACKEND_TOKEN;
    } else {
      process.env.TAB_BACKEND_TOKEN = originalToken;
    }
    if (originalApiUrl === undefined) {
      delete process.env.WEBSITE_API_URL;
    } else {
      process.env.WEBSITE_API_URL = originalApiUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('returns the configured shared secret', () => {
    process.env.TAB_BACKEND_TOKEN = 'test-token-not-placeholder';

    expect(tabBackendAuthHeader()).toBe('test-token-not-placeholder');
  });

  test('fails before making a request when the secret is missing', () => {
    expect(tabBackendAuthHeader).toThrow('TAB_BACKEND_TOKEN');
  });

  test('rejects the old public placeholder', () => {
    process.env.TAB_BACKEND_TOKEN = 'your-secret-token';

    expect(tabBackendAuthHeader).toThrow('TAB_BACKEND_TOKEN');
  });

  test('uses localhost only outside production', () => {
    expect(tabBackendApiUrl()).toBe('http://localhost:5000/api');
  });

  test('fails when WEBSITE_API_URL is absent in production', () => {
    process.env.NODE_ENV = 'production';

    expect(tabBackendApiUrl).toThrow('WEBSITE_API_URL');
  });

  test('normalizes a configured backend URL', () => {
    process.env.WEBSITE_API_URL = 'https://portal.example.test/api/';

    expect(tabBackendApiUrl()).toBe('https://portal.example.test/api');
  });
});
