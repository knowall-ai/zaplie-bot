import { apiUrl } from './appLocation';
import { apiRequestAt } from './wallet/gateway';
import { graphToken } from './graphAdmins';

// The organisation's own view of Zaplie (tabs/backend/tenantRoutes.js).
const TENANT_BASE = apiUrl('/api/tenant');

export interface TenantSettings {
  adminsGroupId: string | null;
  guestAllowlist: string[];
  provisioner: { defaultBudgetSats: number; defaultPeriod: string };
}

export interface TenantMe {
  tid: string;
  isHomeTenant: boolean;
  actingAsPlatform: boolean;
  roles: {
    zaplieAdmin: boolean;
    setupAdmin: boolean;
    platformOperator: boolean;
  };
  clientId: string | null;
  settings: TenantSettings;
}

export const getTenantMe = (): Promise<TenantMe> =>
  apiRequestAt<TenantMe>(TENANT_BASE, '/me');

export const saveTenantSetup = (
  patch: Partial<TenantSettings>,
): Promise<{ settings: TenantSettings }> =>
  apiRequestAt(TENANT_BASE, '/setup', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

// Entra deep links: Entra stays the source of truth for who is an admin.
export const enterpriseAppUsersLink = (clientId: string | null): string =>
  clientId
    ? `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Users/objectId//appId/${encodeURIComponent(clientId)}`
    : 'https://entra.microsoft.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AppAppsPreview';

export const groupMembersLink = (groupId: string): string =>
  `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Members/groupId/${encodeURIComponent(groupId)}`;

/**
 * The organisation's display name from Microsoft Graph (GET /organization
 * needs only User.Read, which sign-in already has), or null when Graph is
 * unavailable: the page then shows the tenant id alone.
 */
export const getOrganizationName = async (): Promise<string | null> => {
  try {
    const token = await graphToken(['User.Read']);
    const response = await fetch(
      'https://graph.microsoft.com/v1.0/organization?$select=displayName',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      value?: { displayName?: string }[];
    };
    return body.value?.[0]?.displayName?.trim() || null;
  } catch {
    return null;
  }
};
