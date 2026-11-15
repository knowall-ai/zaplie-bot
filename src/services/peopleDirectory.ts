// peopleDirectory.ts
//
// The bot's view of Zaplie's people directory, which the portal backend owns
// (tabs/backend/directoryRoutes.js, /api/directory/internal/*). It replaces
// the LNbits admin Users API: the bot never logs in to LNbits, never lists
// LNbits users and never reads a wallet it does not pay from.
//
// What the bot can learn here, and why:
//   * ensurePerson - the turn's sender, with their own Allowance keys (the bot
//     pays from that wallet);
//   * listPeople   - everyone's name and Allowance wallet id + invoice key
//     (the card's recipient list and the leaderboard's payment reads);
//   * getPerson    - one recipient, no keys;
//   * createInvoiceForPerson - an invoice that pays a recipient, made by the
//     portal from their Lightning address or invoice key, which the bot never
//     sees;
//   * getBalances  - the sender's Allowance and (if registered) Private
//     balance.
import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';
import { isRecord } from '../utils/typeGuards';

const DIRECTORY_TIMEOUT_MS = 10000;

interface DirectoryWallet {
  id: string;
  adminkey?: string;
  inkey?: string;
}

interface DirectoryPerson {
  oid: string;
  displayName: string;
  email: string;
  allowanceWalletId: string | null;
  receive: { lightningAddress: string | null; invoiceKeyRegistered: boolean };
  allowanceWallet?: DirectoryWallet | null;
}

// A recipient cannot be invoiced: they have not registered where they
// receive, or their Lightning address refused. Nothing was paid, so a retry
// once they have registered is safe. `message` is safe to show the sender.
export class RecipientNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipientNotReadyError';
  }
}

const directoryFetch = async (
  route: string,
  init: RequestInit = {},
): Promise<Response> =>
  fetch(`${tabBackendApiUrl()}/directory/internal${route}`, {
    ...init,
    headers: {
      Authorization: tabBackendAuthHeader(),
      ...(init.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
  });

const readJson = async (response: Response, what: string): Promise<unknown> => {
  if (!response.ok) {
    throw new Error(`${what} failed (status: ${response.status})`);
  }
  return response.json();
};

const toPerson = (value: unknown, what: string): DirectoryPerson => {
  if (
    !isRecord(value) ||
    typeof value.oid !== 'string' ||
    value.oid === '' ||
    typeof value.displayName !== 'string' ||
    !isRecord(value.receive)
  ) {
    throw new Error(`${what}: the directory returned an invalid person`);
  }
  return value as unknown as DirectoryPerson;
};

// The Wallet shape the commands already use. Only the keys the directory sent
// are set; a missing admin key stays empty and any payment from it fails.
const toWallet = (person: DirectoryPerson): Wallet | null => {
  const wallet = person.allowanceWallet;
  if (!wallet || typeof wallet.id !== 'string' || wallet.id === '') {
    return null;
  }
  return {
    id: wallet.id,
    admin: '',
    name: 'Allowance',
    user: person.oid,
    adminkey: typeof wallet.adminkey === 'string' ? wallet.adminkey : '',
    inkey: typeof wallet.inkey === 'string' ? wallet.inkey : '',
    deleted: false,
  };
};

const toUser = (person: DirectoryPerson): User => ({
  id: person.oid,
  displayName: person.displayName || person.oid,
  profileImg: '',
  aadObjectId: person.oid,
  email: person.email || '',
  allowanceWallet: toWallet(person),
  canReceive: Boolean(
    person.receive.lightningAddress || person.receive.invoiceKeyRegistered,
  ),
});

export interface EnsuredPerson {
  user: User;
  // No Allowance wallet yet: LNBITS_API_TOKEN is not configured and an
  // operator has not linked one. The person can still receive.
  awaitingOperator: boolean;
}

/** Adds the turn's sender to the directory (provisioning when possible). */
export async function ensurePerson(input: {
  aadObjectId: string;
  displayName?: string;
  email?: string;
}): Promise<EnsuredPerson> {
  const body = await readJson(
    await directoryFetch('/people/ensure', {
      method: 'POST',
      body: JSON.stringify({
        aadObjectId: input.aadObjectId,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.email ? { email: input.email } : {}),
      }),
    }),
    'ensurePerson',
  );
  if (!isRecord(body)) {
    throw new Error('ensurePerson: the directory returned no body');
  }
  return {
    user: toUser(toPerson(body.person, 'ensurePerson')),
    awaitingOperator: body.awaitingOperator === true,
  };
}

/** Everyone in the directory. Allowance wallets carry their invoice key only. */
export async function listPeople(): Promise<User[]> {
  const body = await readJson(await directoryFetch('/people'), 'listPeople');
  if (!isRecord(body) || !Array.isArray(body.people)) {
    throw new Error('listPeople: the directory returned no people array');
  }
  return body.people.map(person => toUser(toPerson(person, 'listPeople')));
}

/** One person by Entra object id, or null when they are not registered. */
export async function getPerson(oid: string): Promise<User | null> {
  const response = await directoryFetch(`/people/${encodeURIComponent(oid)}`);
  if (response.status === 404) {
    return null;
  }
  const body = await readJson(response, 'getPerson');
  if (!isRecord(body)) {
    throw new Error('getPerson: the directory returned no body');
  }
  return toUser(toPerson(body.person, 'getPerson'));
}

/**
 * An invoice paying `amountSats` to the person. Throws
 * RecipientNotReadyError for a 409 (nothing to invoice yet), and a plain
 * Error otherwise; in both cases no payment exists, so retrying is safe.
 */
export async function createInvoiceForPerson(
  oid: string,
  amountSats: number,
  memo: string,
  extra: object,
): Promise<string> {
  const response = await directoryFetch(
    `/people/${encodeURIComponent(oid)}/invoices`,
    {
      method: 'POST',
      body: JSON.stringify({ amountSats, memo, extra }),
    },
  );
  if (response.status === 409) {
    const body: unknown = await response.json().catch(() => null);
    throw new RecipientNotReadyError(
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : 'The recipient has not set up where they receive zaps yet.',
    );
  }
  const body = await readJson(response, 'createInvoiceForPerson');
  if (
    !isRecord(body) ||
    typeof body.paymentRequest !== 'string' ||
    !/^ln[a-z0-9]+$/i.test(body.paymentRequest)
  ) {
    throw new Error('createInvoiceForPerson: no payment request returned');
  }
  return body.paymentRequest;
}

export interface PersonBalances {
  allowanceSats: number | null;
  privateSats: number | null;
}

/** Live balances; null for a wallet that is not registered or unreadable. */
export async function getBalances(oid: string): Promise<PersonBalances> {
  const body = await readJson(
    await directoryFetch(`/people/${encodeURIComponent(oid)}/balances`),
    'getBalances',
  );
  const sats = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (!isRecord(body)) {
    throw new Error('getBalances: the directory returned no body');
  }
  return {
    allowanceSats: sats(body.allowanceSats),
    privateSats: sats(body.privateSats),
  };
}
