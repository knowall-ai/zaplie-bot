import { apiUrl } from './appLocation';
import { apiRequestAt } from './wallet/gateway';

// Zaplie's people directory (tabs/backend/directoryRoutes.js). The browser
// never sees a wallet credential. It sends a Lightning address once, to
// register where the signed-in person receives zaps. An admin sends an NWC
// connection string once, to link an Allowance wallet, or a short-lived
// provisioner token for one onboarding request. None of those is ever read
// back.
const DIRECTORY_BASE = apiUrl('/api/directory');
const PROVISION_TIMEOUT_MS = 5 * 60 * 1000;

export interface DirectoryPerson {
  oid: string;
  displayName: string;
  email: string;
  allowanceWalletId: string | null;
  allowanceSource: 'token' | 'operator' | null;
  allowanceLightningAddress: string | null;
  receive: { lightningAddress: string | null };
}

export interface WalletBudget {
  totalSats: number | null;
  usedSats: number | null;
  renewsAt: number | null;
  renewalPeriod: string | null;
}

export interface MyDirectoryEntry extends DirectoryPerson {
  allowanceSats: number | null;
  // Only when the wallet reports its NWC budget (LNbits does not).
  budget: WalletBudget | null;
}

export const getMyDirectoryEntry = (): Promise<MyDirectoryEntry> =>
  apiRequestAt<MyDirectoryEntry>(DIRECTORY_BASE, '/me');

/** Sets (or, with null, clears) the signed-in person's Lightning address. */
export const setMyReceiveAddress = (
  lightningAddress: string | null,
): Promise<DirectoryPerson> =>
  apiRequestAt<DirectoryPerson>(DIRECTORY_BASE, '/me/receive', {
    method: 'PUT',
    body: JSON.stringify({ lightningAddress }),
  });

export interface DirectoryAdminView {
  // Provisioners the backend offers for "Add people", e.g. ['lnbits'].
  provisioners: string[];
  people: DirectoryPerson[];
}

export const listDirectoryPeople = (): Promise<DirectoryAdminView> =>
  apiRequestAt<DirectoryAdminView>(DIRECTORY_BASE, '/admin/people');

/** Manual mode: an NWC connection and the wallet's Lightning address. */
export const linkAllowanceWallet = (
  oid: string,
  link: { nwcUrl: string; lightningAddress?: string; displayName?: string },
): Promise<{ person: DirectoryPerson; balanceSats: number | null }> =>
  apiRequestAt(
    DIRECTORY_BASE,
    `/admin/people/${encodeURIComponent(oid)}/allowance-wallet`,
    { method: 'PUT', body: JSON.stringify(link) },
  );

export type ProvisionPeriod = 'daily' | 'weekly' | 'monthly';

export interface ProvisionResult {
  oid: string;
  displayName: string | null;
  status: 'provisioned' | 'already-linked' | 'failed';
  lightningAddress?: string;
  message?: string;
}

/**
 * Provisioner mode: the backend creates each person's wallet, NWC
 * connection and pay link with `token`, which it uses for this request only.
 */
export const provisionPeople = (request: {
  provisioner: string;
  token: string;
  people: { oid: string; displayName?: string }[];
  budgetSats: number;
  period: ProvisionPeriod;
}): Promise<{ results: ProvisionResult[] }> =>
  apiRequestAt(
    DIRECTORY_BASE,
    '/admin/people/provision',
    { method: 'POST', body: JSON.stringify(request) },
    // Several wallets, each verified over NWC: longer than a normal call.
    PROVISION_TIMEOUT_MS,
  );
