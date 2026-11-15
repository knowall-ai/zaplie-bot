import { AccountInfo } from '@azure/msal-browser';
import { isSetupAdmin, isZaplieAdmin, ROLE_TEMPLATES } from './adminRole';

const account = (claims: Record<string, unknown>) =>
  ({ idTokenClaims: claims }) as unknown as AccountInfo;

describe('admin roles from the token', () => {
  test('the Zaplie.Admin app role, or Global Administrator, is a Zaplie admin', () => {
    expect(isZaplieAdmin(account({ roles: ['Zaplie.Admin'] }))).toBe(true);
    expect(
      isZaplieAdmin(
        account({ wids: [ROLE_TEMPLATES.globalAdministrator.toUpperCase()] }),
      ),
    ).toBe(true);
    expect(
      isZaplieAdmin(
        account({ wids: [ROLE_TEMPLATES.applicationAdministrator] }),
      ),
    ).toBe(false);
    expect(isZaplieAdmin(undefined)).toBe(false);
  });

  test('IT roles that grant consent may open setup', () => {
    expect(
      isSetupAdmin(
        account({ wids: [ROLE_TEMPLATES.cloudApplicationAdministrator] }),
      ),
    ).toBe(true);
    expect(
      isSetupAdmin(account({ wids: ['00000000-0000-0000-0000-000000000000'] })),
    ).toBe(false);
    expect(isSetupAdmin(account({ roles: ['Zaplie.Admin'] }))).toBe(true);
  });
});
