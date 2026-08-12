import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { acquireAdminApiAccessToken, isZaplieAdmin } from './adminApiAuth';

const account = { homeAccountId: 'account-1' } as never;

beforeEach(() => {
  process.env.REACT_APP_ADMIN_API_SCOPE = 'api://zaplie/access_as_user';
});

afterEach(() => {
  delete process.env.REACT_APP_ADMIN_API_SCOPE;
});

test('returns the API access token rather than the ID token', async () => {
  const instance = {
    acquireTokenSilent: jest.fn().mockResolvedValue({
      accessToken: 'api-access-token',
      idToken: 'id-token-must-not-be-used',
    }),
    acquireTokenPopup: jest.fn(),
  } as never;

  await expect(acquireAdminApiAccessToken(instance, account)).resolves.toBe(
    'api-access-token',
  );
});

test('fails before requesting a token when the API scope is absent', async () => {
  delete process.env.REACT_APP_ADMIN_API_SCOPE;
  const acquireTokenSilent = jest.fn();
  const instance = {
    acquireTokenSilent,
    acquireTokenPopup: jest.fn(),
  } as never;

  await expect(acquireAdminApiAccessToken(instance, account)).rejects.toThrow(
    'REACT_APP_ADMIN_API_SCOPE is required',
  );
  expect(acquireTokenSilent).not.toHaveBeenCalled();
});

test('uses an interactive API-scope request only when MSAL requires it', async () => {
  const acquireTokenPopup = jest.fn().mockResolvedValue({
    accessToken: 'interactive-access-token',
  });
  const instance = {
    acquireTokenSilent: jest
      .fn()
      .mockRejectedValue(
        new InteractionRequiredAuthError('interaction_required'),
      ),
    acquireTokenPopup,
  } as never;

  await expect(acquireAdminApiAccessToken(instance, account)).resolves.toBe(
    'interactive-access-token',
  );
  expect(acquireTokenPopup).toHaveBeenCalledWith({
    account,
    scopes: ['api://zaplie/access_as_user'],
  });
});

test('recognizes the exact Zaplie administrator claim for UI gating', () => {
  expect(
    isZaplieAdmin({ idTokenClaims: { roles: ['Zaplie.Admin'] } } as never),
  ).toBe(true);
  expect(
    isZaplieAdmin({ idTokenClaims: { roles: ['Other.Role'] } } as never),
  ).toBe(false);
  expect(isZaplieAdmin(undefined)).toBe(false);
});
