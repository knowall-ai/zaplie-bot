import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { getMsalInstance } from './msalClient';

// The tenant's "Zaplie Admins" group, read and (when allowed) changed through
// Microsoft Graph with the signed-in admin's own delegated token. Entra stays
// the single source of truth: Zaplie keeps no admin list.
//
// Delegated from the browser rather than on-behalf-of in the backend: the
// portal backend holds no client secret and receives ID tokens, which cannot
// be exchanged (issue #184). Read needs GroupMember.Read.All; changes need
// the optional GroupMember.ReadWrite.All (+ User.ReadBasic.All to find a
// person), and Graph refuses them unless the admin may manage the group.
const GRAPH = 'https://graph.microsoft.com/v1.0';
export const READ_SCOPES = ['GroupMember.Read.All'];
export const WRITE_SCOPES = ['GroupMember.ReadWrite.All', 'User.ReadBasic.All'];

export class GraphPermissionMissingError extends Error {
  constructor(readonly scopes: string[]) {
    super(`Microsoft Graph permission not granted: ${scopes.join(', ')}`);
    this.name = 'GraphPermissionMissingError';
  }
}

export interface GroupMember {
  id: string;
  displayName: string;
  userPrincipalName: string | null;
}

/** A Graph token for `scopes`, silently, or GraphPermissionMissingError. */
export const graphToken = async (scopes: string[]): Promise<string> => {
  const instance = getMsalInstance();
  const account = instance.getActiveAccount() || instance.getAllAccounts()[0];
  if (!account) throw new Error('Sign in is required');
  try {
    const result = await instance.acquireTokenSilent({ scopes, account });
    return result.accessToken;
  } catch (error) {
    if (
      error instanceof InteractionRequiredAuthError ||
      /consent|interaction_required|AADSTS65001/i.test(
        String((error as Error)?.message),
      )
    ) {
      throw new GraphPermissionMissingError(scopes);
    }
    throw error;
  }
};

const graph = async <T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const response = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (response.status === 403) {
    throw new GraphPermissionMissingError(WRITE_SCOPES);
  }
  if (!response.ok) {
    throw new Error(`Microsoft Graph answered ${response.status}`);
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
};

export const listGroupMembers = async (
  groupId: string,
): Promise<GroupMember[]> => {
  const token = await graphToken(READ_SCOPES);
  const body = await graph<{ value: GroupMember[] }>(
    token,
    `/groups/${encodeURIComponent(groupId)}/members?$select=id,displayName,userPrincipalName&$top=100`,
  );
  return (body.value || []).map(member => ({
    id: member.id,
    displayName: member.displayName,
    userPrincipalName: member.userPrincipalName || null,
  }));
};

/** True when the signed-in admin holds the optional write permission. */
export const canManageMembers = async (): Promise<boolean> => {
  try {
    await graphToken(WRITE_SCOPES);
    return true;
  } catch {
    return false;
  }
};

export const addGroupMember = async (
  groupId: string,
  userPrincipalName: string,
): Promise<void> => {
  const token = await graphToken(WRITE_SCOPES);
  const user = await graph<{ id: string }>(
    token,
    `/users/${encodeURIComponent(userPrincipalName)}?$select=id`,
  );
  await graph(token, `/groups/${encodeURIComponent(groupId)}/members/$ref`, {
    method: 'POST',
    body: JSON.stringify({
      '@odata.id': `${GRAPH}/directoryObjects/${user.id}`,
    }),
  });
};

export const removeGroupMember = async (
  groupId: string,
  memberId: string,
): Promise<void> => {
  const token = await graphToken(WRITE_SCOPES);
  await graph(
    token,
    `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}/$ref`,
    { method: 'DELETE' },
  );
};
