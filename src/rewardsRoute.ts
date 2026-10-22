import { Response, Router } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { getWebhookKeyHashes } from './services/fetchWebhookKeys';
import {
  parseRewardRequest,
  resolveAmountSats,
  assertRepoConnected,
  payReward,
  RewardError,
  RewardPaymentUncertainError,
} from './services/rewardsService';
import { recordRewardOutcome } from './services/pulse';
import {
  PaidRewardResponse,
  PendingRewardResponse,
  RewardEntry,
  RewardLedger,
  rewardFingerprint,
  rewardKey,
} from './services/rewardLedger';

// Printable ASCII only: a GitHub delivery id is a GUID, and anything outside
// this range is a malformed header rather than a key worth hashing.
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,256}$/;

/**
 * True if the presented key matches `REWARDS_API_KEY` or the hash of any
 * active portal-managed key (created and revoked by admins in Automations).
 *
 * @throws RewardError 503 when no key is configured anywhere
 */
export const isAuthorizedRewardKey = async (
  providedKey: string,
): Promise<boolean> => {
  const envKey = process.env.REWARDS_API_KEY;
  if (envKey) {
    // Buffers, not strings: timingSafeEqual throws on byte-length mismatch.
    const provided = Buffer.from(providedKey);
    const expected = Buffer.from(envKey);
    if (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    ) {
      return true;
    }
  }
  const hashes = await getWebhookKeyHashes();
  if (!envKey && hashes.length === 0) {
    throw new RewardError(
      'rewards endpoint disabled: no API keys configured',
      503,
    );
  }
  const providedHash = createHash('sha256').update(providedKey).digest('hex');
  return hashes.includes(providedHash);
};

export interface RewardsRouteDeps {
  ledger: Pick<
    RewardLedger,
    | 'reserve'
    | 'markPaid'
    | 'markPending'
    | 'markUncertain'
    | 'releaseIfProcessing'
  >;
  isAuthorizedRewardKey?: (providedKey: string) => Promise<boolean>;
  parseRewardRequest?: typeof parseRewardRequest;
  assertRepoConnected?: typeof assertRepoConnected;
  resolveAmountSats?: typeof resolveAmountSats;
  payReward?: typeof payReward;
  recordRewardOutcome?: typeof recordRewardOutcome;
}

// A replay answers with the stored outcome and records nothing: the first
// request already did, and a redelivery is not a new reward.
const replay = (res: Response, entry: RewardEntry): void => {
  switch (entry.state) {
    case 'paid':
      res.set('Idempotency-Replayed', 'true').status(200).json(entry.response);
      return;
    case 'pending':
      res.set('Idempotency-Replayed', 'true').status(202).json(entry.response);
      return;
    case 'processing':
      res.status(409).json({
        status: 'processing',
        error: 'reward is already being processed',
      });
      return;
    case 'uncertain':
      res.status(409).json({
        status: 'uncertain',
        error: 'payment outcome unknown; needs reconciliation',
      });
      return;
  }
};

/**
 * Router for `POST /api/v1/rewards`, the deterministic automation path: no
 * LLM can trigger a payment here. Every request needs an `Idempotency-Key`,
 * claimed in the reward ledger before anything is paid, so a repeat replays
 * the first result instead of paying again.
 *
 * @param deps the ledger, plus optional stand-ins for the reward services
 *   (tests only; each defaults to the real module)
 */
export const createRewardsRouter = (deps: RewardsRouteDeps): Router => {
  const {
    ledger,
    isAuthorizedRewardKey: isAuthorized = isAuthorizedRewardKey,
    parseRewardRequest: parse = parseRewardRequest,
    assertRepoConnected: assertConnected = assertRepoConnected,
    resolveAmountSats: resolveAmount = resolveAmountSats,
    payReward: pay = payReward,
    recordRewardOutcome: record = recordRewardOutcome,
  } = deps;
  const router = Router();

  // A failure here leaves the key `processing`, which blocks every retry with
  // a 409 until an operator clears it: safe, never a second payment.
  const release = async (ledgerKey: string): Promise<void> => {
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

  const fail = (res: Response, error: unknown, ledgerKey: string): void => {
    if (error instanceof RewardError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    // Internals (env names, LNbits ids) must not leak into Logic App run history.
    console.error('rewards payment failed:', error);
    record({ status: 'failed', requestKey: ledgerKey });
    res.status(500).json({ error: 'internal error' });
  };

  router.post('/api/v1/rewards', async (req, res) => {
    try {
      if (!(await isAuthorized(req.header('x-api-key') ?? ''))) {
        res.status(401).json({ error: 'invalid API key' });
        return;
      }
    } catch (error) {
      if (error instanceof RewardError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      console.error('rewards key validation failed:', error);
      res.status(503).json({ error: 'rewards endpoint unavailable' });
      return;
    }

    // Required rather than derived from the body: only the caller knows what
    // makes two deliveries the same (GitHub's X-GitHub-Delivery), and two
    // genuine identical rewards must still both pay.
    const idempotencyKey = req.header('idempotency-key');
    if (!idempotencyKey) {
      res.status(400).json({ error: 'Idempotency-Key header is required' });
      return;
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      res.status(400).json({ error: 'Idempotency-Key header is invalid' });
      return;
    }
    const ledgerKey = rewardKey(idempotencyKey);

    let request;
    try {
      request = parse(req.body);
    } catch (error) {
      fail(res, error, ledgerKey);
      return;
    }

    let reservation;
    try {
      reservation = await ledger.reserve(ledgerKey, rewardFingerprint(request));
    } catch (error) {
      // Nothing was reserved or paid, so the caller's retry is safe.
      console.error('rewards ledger unavailable:', error);
      res.status(503).json({ error: 'rewards endpoint unavailable' });
      return;
    }
    if (reservation.kind === 'conflict') {
      res.status(409).json({
        error: 'Idempotency-Key was already used for a different reward',
      });
      return;
    }
    if (reservation.kind === 'replay') {
      replay(res, reservation.entry);
      return;
    }

    let amountSats: number;
    try {
      // This draft endpoint is deliberately restricted to GitHub. Generic flow
      // identities need a separate provider-aware contract before they can pay.
      await assertConnected(request.repo);
      amountSats = await resolveAmount(request);
    } catch (error) {
      await release(ledgerKey);
      fail(res, error, ledgerKey);
      return;
    }

    let result;
    try {
      result = await pay({ ...request, amountSats });
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
        res.status(500).json({ error: 'payment outcome unknown' });
        return;
      }
      // Anything else failed before the payment or pending-reward request
      // took effect, so a retry may pay.
      await release(ledgerKey);
      fail(res, error, ledgerKey);
      return;
    }

    if ('pending' in result) {
      const body: PendingRewardResponse = {
        status: 'pending',
        recipient: request.recipient,
        amountSats,
      };
      await settle(() => ledger.markPending(ledgerKey, body));
      record({ status: 'pending', requestKey: ledgerKey, sats: amountSats });
      res.status(202).json(body);
      return;
    }
    const body: PaidRewardResponse = {
      status: 'paid',
      paymentHash: result.paymentHash,
      recipient: request.recipient,
      amountSats,
    };
    await settle(() => ledger.markPaid(ledgerKey, body));
    record({
      status: 'paid',
      paymentHash: result.paymentHash,
      sats: amountSats,
    });
    res.status(200).json(body);
  });

  return router;
};
