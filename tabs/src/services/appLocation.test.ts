import { afterEach, describe, expect, test } from '@jest/globals';
import {
  apiUrl,
  appUrl,
  getApiBaseUrl,
  getAppOrigin,
  getBasePath,
} from './appLocation';

const originalPublicUrl = process.env.PUBLIC_URL;
const originalApiBaseUrl = process.env.REACT_APP_API_BASE_URL;

const setEnv = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

afterEach(() => {
  setEnv('PUBLIC_URL', originalPublicUrl);
  setEnv('REACT_APP_API_BASE_URL', originalApiBaseUrl);
});

describe('getBasePath', () => {
  test.each([undefined, '', ' ', '/', '.'])(
    'is empty at the root (PUBLIC_URL=%p)',
    value => {
      setEnv('PUBLIC_URL', value);
      expect(getBasePath()).toBe('');
    },
  );

  test.each([
    ['/portal', '/portal'],
    ['/portal/', '/portal'],
    ['portal', '/portal'],
    ['/portal//', '/portal'],
    ['https://getzapl.ie/portal/', '/portal'],
    ['https://getzapl.ie', ''],
  ])('normalises PUBLIC_URL=%p to %p', (value, expected) => {
    setEnv('PUBLIC_URL', value);
    expect(getBasePath()).toBe(expected);
  });
});

describe('getAppOrigin and appUrl', () => {
  test('stay on the bare origin at the root, as the registered redirect URI', () => {
    setEnv('PUBLIC_URL', '');
    expect(getAppOrigin('https://tabs.example')).toBe('https://tabs.example');
    expect(appUrl('/auth-end', 'https://tabs.example')).toBe(
      'https://tabs.example/auth-end',
    );
  });

  test('include the base path under /portal/', () => {
    setEnv('PUBLIC_URL', '/portal');
    expect(getAppOrigin('https://getzapl.ie')).toBe(
      'https://getzapl.ie/portal',
    );
    expect(appUrl('/auth-end', 'https://getzapl.ie')).toBe(
      'https://getzapl.ie/portal/auth-end',
    );
    expect(appUrl('login', 'https://getzapl.ie')).toBe(
      'https://getzapl.ie/portal/login',
    );
  });

  test('default to the page origin', () => {
    setEnv('PUBLIC_URL', '/portal');
    expect(getAppOrigin()).toBe(`${window.location.origin}/portal`);
    expect(appUrl('/login')).toBe(`${window.location.origin}/portal/login`);
  });
});

describe('getApiBaseUrl and apiUrl', () => {
  test('keep API calls same-origin when nothing is configured', () => {
    setEnv('REACT_APP_API_BASE_URL', undefined);
    expect(getApiBaseUrl()).toBe('');
    expect(apiUrl('/api/reward-name')).toBe('/api/reward-name');
  });

  test('prefix API paths with the configured backend origin', () => {
    setEnv(
      'REACT_APP_API_BASE_URL',
      'https://zaplie-prod-webapp.azurewebsites.net/',
    );
    expect(getApiBaseUrl()).toBe(
      'https://zaplie-prod-webapp.azurewebsites.net',
    );
    expect(apiUrl('/api/lnbits/wallets')).toBe(
      'https://zaplie-prod-webapp.azurewebsites.net/api/lnbits/wallets',
    );
    expect(apiUrl('api/reports')).toBe(
      'https://zaplie-prod-webapp.azurewebsites.net/api/reports',
    );
  });
});
