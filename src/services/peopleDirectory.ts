// peopleDirectory.ts
//
// The bot's only way to people and money. The portal backend owns Zaplie's
// people directory and every wallet connection
// (tabs/backend/directoryRoutes.js, /api/directory/internal/*, shared
// TAB_BACKEND_TOKEN). The bot holds no wallet credential at all: no LNbits
// login, no wallet key, no NWC connection.
//
//   * ensurePerson  - the turn's sender, added on their first turn;
//   * listPeople / getPerson - names, Entra ids, whether they can receive;
//   * payZap        - the portal pays a zap from the sender's Allowance
//                     wallet to another directory member, both named by
//                     Entra id: the bot never supplies an invoice or address;
//   * payReward     - the portal pays an automation reward from the Treasury
//                     to a directory member;
//   * getBalances   - the sender's Allowance balance (and budget, if the
//                     wallet reports one);
//   * listZaps      - Zaplie's record of every zap and reward it paid.
import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';
import { isRecord } from '../utils/typeGuards';

const DIRECTORY_TIMEOUT_MS = 10000;
// A payment waits for the wallet (NWC over a relay) and the recipient's
// Lightning address; longer than a read, shorter than Teams' patience.
const PAYMENT_TIMEOUT_MS = 25000;

interface DirectoryPerson {
  oid: string;
  displayName: string;
  email: string;
  allowanceWalletId: string | null;
  receive: { lightningAddress: string | null };
}

// The portal refused before anything was paid: retrying (once the cause is
// fixed) is safe. `message` is the portal's wording, safe to show the sender.
export class PaymentNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentNotSentError';
  }
}

// The payment may have left: the portal could not say, or the bot never got
// its answer. Never retried blind; reconciled by the payment records.
export class PaymentOutcomeUncertainError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PaymentOutcomeUncertainError';
  }
}

const directoryFetch = async (
  route: string,
  init: RequestInit = {},
  timeoutMs = DIRECTORY_TIMEOUT_MS,
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
    signal: AbortSignal.timeout(timeoutMs),
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

const toUser = (person: DirectoryPerson): User => ({
  id: person.oid,
  displayName: person.displayName || person.oid,
  profileImg: '',
  aadObjectId: person.oid,
  email: person.email || '',
  allowanceWallet:
    typeof person.allowanceWalletId === 'string' && person.allowanceWalletId
      ? { id: person.allowanceWalletId }
      : null,
  canReceive: Boolean(person.receive.lightningAddress),
});

export interface EnsuredPerson {
  user: User;
  // No Allowance wallet yet: an operator has not linked one. The person can
  // still receive.
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

/** Everyone in the directory. */
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

// Shared by both payment routes: the portal's `outcome` decides. Anything
// without an explicit 'not_paid' (a timeout, a dropped connection, a body
// that does not parse) may have paid, so it is uncertain.
const pay = async (route: string, payload: object): Promise<string> => {
  let response: Response;
  try {
    response = await directoryFetch(
      route,
      { method: 'POST', body: JSON.stringify(payload) },
      PAYMENT_TIMEOUT_MS,
    );
  } catch (error) {
    throw new PaymentOutcomeUncertainError(
      'The payment request did not get an answer from the portal.',
      error,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (
    response.ok &&
    isRecord(body) &&
    body.outcome === 'paid' &&
    typeof body.paymentHash === 'string' &&
    body.paymentHash !== ''
  ) {
    return body.paymentHash;
  }
  const message =
    isRecord(body) && typeof body.error === 'string'
      ? body.error
      : `The payment failed (status: ${response.status}).`;
  if (isRecord(body) && body.outcome === 'not_paid') {
    throw new PaymentNotSentError(message);
  }
  throw new PaymentOutcomeUncertainError(message);
};

/**
 * Pays a zap from the sender's Allowance wallet to another directory member.
 * `idempotencyKey` must stay the same for every retry of one zap, so the
 * portal pays it at most once. Resolves the payment hash.
 */
export const payZap = (input: {
  senderOid: string;
  recipientOid: string;
  amountSats: number;
  memo: string;
  idempotencyKey: string;
}): Promise<string> => pay('/zaps', input);

export interface RewardDetails {
  eventType?: string;
  repo?: string;
  source?: string;
  baseSats?: number;
  bonusSats?: number;
  level?: string;
}

/** Pays an automation reward from the Treasury to a directory member. */
export const payReward = (input: {
  recipientOid: string;
  recipientLabel: string;
  amountSats: number;
  memo: string;
  reward: RewardDetails;
  idempotencyKey: string;
}): Promise<string> => pay('/rewards', input);

export interface PersonBalances {
  allowanceSats: number | null;
  // Only when the wallet reports its NWC budget (LNbits does not).
  budgetRemainingSats: number | null;
}

/** Live Allowance balance; null when there is no wallet or it is unreadable. */
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
  const budget = isRecord(body.budget) ? body.budget : null;
  const total = sats(budget?.totalSats);
  const used = sats(budget?.usedSats);
  return {
    allowanceSats: sats(body.allowanceSats),
    budgetRemainingSats:
      total !== null && used !== null ? Math.max(0, total - used) : null,
  };
}

export interface ZapRecord {
  paymentHash: string;
  kind: 'zap' | 'reward';
  time: number; // Unix seconds
  amountSats: number;
  memo: string;
  from: { oid: string | null; displayName: string };
  to: { oid: string | null; displayName: string };
}

/** Every zap and reward Zaplie paid, newest first, optionally since a time. */
export async function listZaps(sinceSeconds?: number): Promise<ZapRecord[]> {
  const query = sinceSeconds ? `?since=${Math.floor(sinceSeconds)}` : '';
  const body = await readJson(
    await directoryFetch(`/zaps${query}`),
    'listZaps',
  );
  if (!isRecord(body) || !Array.isArray(body.zaps)) {
    throw new Error('listZaps: the directory returned no zaps array');
  }
  return body.zaps.filter(
    (zap): zap is ZapRecord =>
      isRecord(zap) &&
      typeof zap.paymentHash === 'string' &&
      typeof zap.amountSats === 'number' &&
      typeof zap.time === 'number' &&
      isRecord(zap.from) &&
      isRecord(zap.to),
  );
}
