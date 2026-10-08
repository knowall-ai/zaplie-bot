import type { Pulse } from '@knowall-ai/agent-pulse';

// What Zaplie actually does, as AgentActivity events (agent-pulse) for the
// Agents Portal. Everything here is best effort by contract: the library never
// throws, and every call is wrapped anyway, so telemetry can never fail a zap
// or a reply. Titles and subjects are fixed strings: never a person's name,
// a zap message or any other free text, because customer viewers see them.

export const DEFAULT_AGENT_ID = 'zaplie';

export type ActivityLevel = 'info' | 'success' | 'warning' | 'error';

export interface ZaplieActivity {
  activityType: string;
  title: string;
  level: ActivityLevel;
  // The upstream id the activity id is derived from (a Teams message id, a
  // zap-ledger key, a payment hash). Hashed before it leaves the process.
  upstreamId: string;
  subject?: string;
  detail?: string;
  channel: 'teams' | 'api';
  measurements?: Record<string, number>;
}

type PulseLibrary = Pick<
  typeof import('@knowall-ai/agent-pulse'),
  'createPulse' | 'activityIdFrom'
>;

// agent-pulse is ESM-only and the bot compiles to CommonJS, where tsc turns
// import() into require() - which the package does not export. Building the
// import() at runtime keeps it a real ES import.
const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<PulseLibrary>;

let loadLibrary = (): Promise<PulseLibrary> =>
  importEsm('@knowall-ai/agent-pulse');

interface Ready {
  pulse: Pulse;
  activityIdFrom: PulseLibrary['activityIdFrom'];
}

let ready: Promise<Ready | undefined> | undefined;
let inFlight: Promise<void> = Promise.resolve();

const getPulse = (): Promise<Ready | undefined> => {
  if (!ready) {
    const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    // No connection string: emit nothing, and do not even load the library
    // (local development and tests).
    ready = !connectionString
      ? Promise.resolve(undefined)
      : loadLibrary().then(library => ({
          pulse: library.createPulse({
            connectionString,
            agentId: process.env.AGENT_ID || DEFAULT_AGENT_ID,
          }),
          activityIdFrom: library.activityIdFrom,
        }));
  }
  return ready;
};

const warn = (error: unknown): void => {
  console.warn('agent-pulse: could not record an activity.', error);
};

// Fire and forget: the caller never waits for, or hears about, telemetry.
export const recordActivity = (activity: ZaplieActivity): void => {
  try {
    const { upstreamId, ...event } = activity;
    const sent = getPulse()
      .then(loaded =>
        loaded?.pulse.emit({
          ...event,
          activityId: loaded.activityIdFrom(upstreamId),
        }),
      )
      .catch(warn);
    inFlight = Promise.all([inFlight, sent]).then(() => undefined);
  } catch (error) {
    warn(error);
  }
};

// A registered command name ("send zap") as a fixed subject bucket.
export const commandSubject = (commandName: string): string =>
  commandName.trim().toLowerCase().replace(/\s+/g, '-');

export type ZapOutcomeStatus = 'paid' | 'failed' | 'needs-checking';

// One zap-card recipient's outcome. Skipped recipients (a duplicate submit)
// did nothing new and are not recorded.
export const recordZapOutcome = (
  status: ZapOutcomeStatus,
  ledgerKey: string,
  sats: number,
): void => {
  const measurements = { sats };
  if (status === 'paid') {
    recordActivity({
      activityType: 'zap.sent',
      title: 'Sent a zap · teams',
      level: 'success',
      subject: 'teams',
      channel: 'teams',
      upstreamId: ledgerKey,
      measurements,
    });
  } else if (status === 'needs-checking') {
    // Sent but never confirmed: the bot gives up and asks an admin to check.
    recordActivity({
      activityType: 'zap.failed',
      title: 'Zap outcome needs checking · teams',
      level: 'warning',
      subject: 'outcome-unknown',
      detail: 'Payment sent but not confirmed; an admin should verify.',
      channel: 'teams',
      upstreamId: ledgerKey,
      measurements,
    });
  } else {
    recordActivity({
      activityType: 'zap.failed',
      title: 'Zap failed · teams',
      level: 'error',
      subject: 'before-payment',
      detail: 'Nothing was paid; the sender can retry.',
      channel: 'teams',
      upstreamId: ledgerKey,
      measurements,
    });
  }
};

export type RewardOutcome =
  | { status: 'paid'; paymentHash: string; sats: number }
  | { status: 'pending'; requestKey: string; sats: number }
  | { status: 'failed'; requestKey: string };

// An automation reward from POST /api/v1/rewards.
export const recordRewardOutcome = (outcome: RewardOutcome): void => {
  if (outcome.status === 'paid') {
    recordActivity({
      activityType: 'zap.sent',
      title: 'Sent a zap · automation',
      level: 'success',
      subject: 'automation',
      channel: 'api',
      upstreamId: outcome.paymentHash,
      measurements: { sats: outcome.sats },
    });
  } else if (outcome.status === 'pending') {
    recordActivity({
      activityType: 'zap.queued',
      title: 'Queued a zap · automation',
      level: 'info',
      subject: 'automation',
      detail: 'Recipient has not connected a wallet yet.',
      channel: 'api',
      upstreamId: outcome.requestKey,
      measurements: { sats: outcome.sats },
    });
  } else {
    recordActivity({
      activityType: 'zap.failed',
      title: 'Zap failed · automation',
      level: 'error',
      subject: 'automation',
      channel: 'api',
      upstreamId: outcome.requestKey,
    });
  }
};

// For tests: drop the memoised pulse and, optionally, load a stand-in for
// the library (jest cannot run the real ES import).
export const resetPulseForTests = (
  load?: () => Promise<PulseLibrary>,
): void => {
  ready = undefined;
  if (load) {
    loadLibrary = load;
  }
};

// For tests: wait for every activity recorded so far to reach the library.
export const pulseSettled = (): Promise<void> => inFlight;
