import { createHash } from 'crypto';
import {
  parseRewardRequest,
  resolveAmountSats,
  resolveRewardRecipient,
  assertRepoConnected,
  payReward,
  RewardAmount,
  RewardError,
  RewardPaymentUncertainError,
} from './rewardsService';
import { recordRewardOutcome } from './pulse';
import { ResolvedRewardRecipient } from './identityService';
import {
  BudgetReservation,
  getRewardBudget,
  RewardBudgetLedger,
} from './rewardBudget';
import { rewardPeriodKey } from './rewardPeriod';
import {
  PaidRewardResponse,
  PendingRewardResponse,
  RewardEntry,
  RewardLedger,
  rewardFingerprint,
  rewardKey,
} from './rewardLedger';

// Printable ASCII only: a GitHub delivery id is a GUID, and anything outside
// this range is a malformed header rather than a key worth hashing.
export const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,256}$/;

export interface ProcessRewardDeps {
  ledger: Pick<
    RewardLedger,
    | 'reserve'
    | 'markPaid'
    | 'markPending'
    | 'markUncertain'
    | 'releaseIfProcessing'
  >;
  // Required: no budget ledger, no payment.
  budgetLedger: Pick<RewardBudgetLedger, 'reserve' | 'release'>;
  getRewardBudget?: typeof getRewardBudget;
  now?: () => number;
  parseRewardRequest?: typeof parseRewardRequest;
  assertRepoConnected?: typeof assertRepoConnected;
  resolveRewardRecipient?: typeof resolveRewardRecipient;
  resolveAmountSats?: typeof resolveAmountSats;
  payReward?: typeof payReward;
  recordRewardOutcome?: typeof recordRewardOutcome;
}

export interface ProcessRewardInput {
  // Already checked against IDEMPOTENCY_KEY_PATTERN by the caller.
  idempotencyKey: string;
  // The untrusted reward body; parsed here so every caller gets one rule.
  body: unknown;
}

/**
 * What the HTTP layer sends: a status, a JSON body, and whether this is a
 * replay of an earlier result (`Idempotency-Replayed: true`).
 */
export interface ProcessRewardResult {
  status: number;
  replayed?: true;
  body: unknown;
}

// A replay answers with the stored outcome and records nothing: the first
// request already did, and a redelivery is not a new reward.
const replay = (entry: RewardEntry): ProcessRewardResult => {
  switch (entry.state) {
    case 'paid':
      return { status: 200, replayed: true, body: entry.response };
    case 'pending':
      return { status: 202, replayed: true, body: entry.response };
    case 'processing':
      return {
        status: 409,
        body: {
          status: 'processing',
          error: 'reward is already being processed',
        },
      };
    case 'uncertain':
      return {
        status: 409,
        body: {
          status: 'uncertain',
          error: 'payment outcome unknown; needs reconciliation',
        },
      };
  }
};

/**
 * The deterministic reward pipeline shared by `POST /api/v1/rewards` and the
 * signed GitHub webhook: parse, claim the idempotency key, check the repo,
 * resolve the configured amount, pay, settle. No caller can choose an amount.
 *
 * Authentication is the caller's job; this function trusts that it ran.
 *
 * @param deps the ledger, plus optional stand-ins for the reward services
 *   (tests only; each defaults to the real module)
 */
export const processReward = async (
  deps: ProcessRewardDeps,
  { idempotencyKey, body }: ProcessRewardInput,
): Promise<ProcessRewardResult> => {
  const {
    ledger,
    parseRewardRequest: parse = parseRewardRequest,
    assertRepoConnected: assertConnected = assertRepoConnected,
    resolveRewardRecipient: resolveRecipient = resolveRewardRecipient,
    resolveAmountSats: resolveAmount = resolveAmountSats,
    payReward: pay = payReward,
    recordRewardOutcome: record = recordRewardOutcome,
    budgetLedger,
    getRewardBudget: getBudget = getRewardBudget,
    now = Date.now,
  } = deps;

  const ledgerKey = rewardKey(idempotencyKey);

  // A failure here leaves the key `processing`, which blocks every retry with
  // a 409 until an operator clears it: safe, never a second payment.
  const release = async (): Promise<void> => {
    try {
      await ledger.releaseIfProcessing(ledgerKey);
    } catch (error) {
      console.error(
        'rewards ledger could not release an unpaid reward; it stays processing until reconciled:',
        error,
      );
    }
  };

  // The reward has already been paid or queued, so the response still says
  // so. A ledger that could not record it keeps the key `processing`, which
  // blocks redelivery: the operator reconciles it, nobody is paid twice.
  const settle = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      console.error(
        'rewards ledger could not record a settled reward; it stays processing until reconciled:',
        error,
      );
    }
  };

  const fail = (error: unknown): ProcessRewardResult => {
    if (error instanceof RewardError) {
      return { status: error.statusCode, body: { error: error.message } };
    }
    // Internals (env names, LNbits ids) must not leak to the caller.
    console.error('rewards payment failed:', error);
    record({ status: 'failed', requestKey: ledgerKey });
    return { status: 500, body: { error: 'internal error' } };
  };

  let request;
  try {
    request = parse(body);
  } catch (error) {
    return fail(error);
  }

  let reservation;
  try {
    reservation = await ledger.reserve(ledgerKey, rewardFingerprint(request));
  } catch (error) {
    // Nothing was reserved or paid, so the caller's retry is safe.
    console.error('rewards ledger unavailable:', error);
    return { status: 503, body: { error: 'rewards endpoint unavailable' } };
  }
  if (reservation.kind === 'conflict') {
    return {
      status: 409,
      body: {
        error: 'Idempotency-Key was already used for a different reward',
      },
    };
  }
  if (reservation.kind === 'replay') {
    return replay(reservation.entry);
  }

  let amountSats: number;
  let recipient: ResolvedRewardRecipient | null;
  let amount: RewardAmount;
  let periodKey: string;
  let budgetOutcome: BudgetReservation | null;
  try {
    // Restricted to GitHub. Generic flow identities need a separate
    // provider-aware contract before they can pay.
    await assertConnected(request.repo);
    // Who before how much: a person's base override depends on who they
    // are. A resolution failure is before payment, so the key is released.
    recipient = await resolveRecipient(request);
    amount = await resolveAmount(request, recipient);
    amountSats = amount.amountSats;
    // The aggregate cap, checked and claimed under one lock before paying.
    // No budget configured is a 503 here, with nothing paid.
    const budget = await getBudget();
    periodKey = rewardPeriodKey(now(), budget.period, budget.timezone);
    // An unlinked recipient is held as pending, and nothing pays pending yet:
    // holding its sats would only shrink the period for linked people, and
    // near the cap it would refuse a reward that pays nothing. Paying it
    // later must reserve then.
    budgetOutcome =
      recipient === null
        ? null
        : await budgetLedger.reserve(
            periodKey,
            ledgerKey,
            amountSats,
            budget.capSats,
          );
  } catch (error) {
    await release();
    return fail(error);
  }
  if (budgetOutcome === 'exceeded') {
    // Nothing was paid, so the key is released: a manual redelivery in a
    // later period (a human decision) can still pay it.
    await release();
    record({ status: 'failed', requestKey: ledgerKey });
    return {
      status: 402,
      body: { error: 'reward budget exhausted for this period' },
    };
  }
  // Only for failures known to be before the payment left the bot. A
  // failure here keeps the reservation: it over-counts, never over-pays.
  const releaseBudget = async (): Promise<void> => {
    if (budgetOutcome === null) {
      return;
    }
    try {
      await budgetLedger.release(periodKey, ledgerKey);
    } catch (error) {
      console.error(
        'reward budget could not release an unpaid reward; it stays counted:',
        error,
      );
    }
  };

  let result;
  try {
    result = await pay(
      {
        ...request,
        amountSats,
        baseSats: amount.baseSats,
        bonusSats: amount.bonusSats,
        level: amount.level,
      },
      recipient,
      createHash('sha256').update(ledgerKey).digest('hex'),
    );
  } catch (error) {
    if (error instanceof RewardPaymentUncertainError) {
      // It may have paid, or queued a pending reward that pays later, so
      // the key is never released: every redelivery gets a 409 until an
      // operator reconciles it.
      console.error('rewards payment outcome unknown:', error);
      await settle(() => ledger.markUncertain(ledgerKey));
      record({
        status: 'needs-checking',
        requestKey: ledgerKey,
        sats: amountSats,
      });
      return { status: 500, body: { error: 'payment outcome unknown' } };
    }
    // Anything else failed before the payment or pending-reward request
    // took effect, so a retry may pay.
    await releaseBudget();
    await release();
    return fail(error);
  }

  if ('pending' in result) {
    const pendingBody: PendingRewardResponse = {
      status: 'pending',
      recipient: request.recipient,
      amountSats,
    };
    await settle(() => ledger.markPending(ledgerKey, pendingBody));
    record({ status: 'pending', requestKey: ledgerKey, sats: amountSats });
    return { status: 202, body: pendingBody };
  }
  const paidBody: PaidRewardResponse = {
    status: 'paid',
    paymentHash: result.paymentHash,
    recipient: request.recipient,
    amountSats,
  };
  await settle(() => ledger.markPaid(ledgerKey, paidBody));
  record({
    status: 'paid',
    paymentHash: result.paymentHash,
    sats: amountSats,
  });
  return { status: 200, body: paidBody };
};
