process.env.AAD_APP_TENANT_ID = 'tenant-id';
process.env.AAD_APP_CLIENT_ID = 'api-client-id';

const mockJwtVerify = jest.fn();
const mockCreateRemoteJWKSet = jest.fn(() => 'test-jwks');

jest.mock('jose', () => ({
  createRemoteJWKSet: mockCreateRemoteJWKSet,
  jwtVerify: mockJwtVerify,
}));

const { verifyMsalAccessToken } = require('./msalValidator');

beforeEach(() => {
  mockJwtVerify.mockReset();
});

test('verifies a delegated API access token and returns its authorization claims', async () => {
  mockJwtVerify.mockResolvedValue({
    payload: {
      oid: 'user-oid',
      roles: ['Zaplie.Admin'],
      scp: 'openid access_as_user',
    },
  });

  await expect(verifyMsalAccessToken('signed-access-token')).resolves.toEqual({
    oid: 'user-oid',
    roles: ['Zaplie.Admin'],
  });
  expect(mockJwtVerify).toHaveBeenCalledWith('signed-access-token', 'test-jwks', {
    issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
    audience: 'api-client-id',
    algorithms: ['RS256'],
  });
});

test('rejects a token that was not issued for delegated API access', async () => {
  mockJwtVerify.mockResolvedValue({
    payload: { oid: 'user-oid', roles: ['Zaplie.Admin'], scp: 'User.Read' },
  });

  await expect(verifyMsalAccessToken('graph-token')).rejects.toThrow('access_as_user');
});
