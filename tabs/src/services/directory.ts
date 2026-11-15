import { apiUrl } from './appLocation';
import { apiRequestAt } from './lnbits/gateway';

// Zaplie's people directory (tabs/backend/directoryRoutes.js). The browser
// never sees a wallet key: it sends a Lightning address or an invoice key
// once, to register where the signed-in person receives zaps, and an admin
// sends an Allowance wallet's keys once, to link it. Neither is ever read
// back.
const DIRECTORY_BASE = apiUrl('/api/directory');

export interface DirectoryPerson {
  oid: string;
  displayName: string;
  email: string;
  allowanceWalletId: string | null;
  allowanceSource: 'token' | 'operator' | null;
  receive: { lightningAddress: string | null; invoiceKeyRegistered: boolean };
}

export interface MyDirectoryEntry extends DirectoryPerson {
  allowanceSats: number | null;
  privateSats: number | null;
  // How Allowance wallets are created: by Zaplie on sign-in, or by an admin.
  provisioning: 'automatic' | 'operator';
}

export const getMyDirectoryEntry = (): Promise<MyDirectoryEntry> =>
  apiRequestAt<MyDirectoryEntry>(DIRECTORY_BASE, '/me');

/**
 * Sets where the signed-in person receives zaps. A field left undefined is
 * kept; null clears it.
 */
export const setMyReceiveTarget = (target: {
  lightningAddress?: string | null;
  invoiceKey?: string | null;
}): Promise<DirectoryPerson> =>
  apiRequestAt<DirectoryPerson>(DIRECTORY_BASE, '/me/receive', {
    method: 'PUT',
    body: JSON.stringify(target),
  });

export interface DirectoryAdminView {
  provisioning: 'automatic' | 'operator';
  people: DirectoryPerson[];
}

export const listDirectoryPeople = (): Promise<DirectoryAdminView> =>
  apiRequestAt<DirectoryAdminView>(DIRECTORY_BASE, '/admin/people');

export const linkAllowanceWallet = (
  oid: string,
  keys: { adminkey: string; inkey: string; displayName?: string },
): Promise<{ person: DirectoryPerson; ownershipVerified: boolean }> =>
  apiRequestAt(
    DIRECTORY_BASE,
    `/admin/people/${encodeURIComponent(oid)}/allowance-wallet`,
    { method: 'PUT', body: JSON.stringify(keys) },
  );

export const provisionAllowanceWallet = (
  oid: string,
): Promise<{ person: DirectoryPerson }> =>
  apiRequestAt(
    DIRECTORY_BASE,
    `/admin/people/${encodeURIComponent(oid)}/provision`,
    { method: 'POST' },
  );
