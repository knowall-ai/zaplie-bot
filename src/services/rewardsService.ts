import {
  getUserWalletsByUserId,
  createInvoice,
  payInvoice,
} from './lnbitsService';
import { getRewardAmounts } from './fetchRewardAmounts';
import { getAutomations } from './fetchAutomations';
import { resolveRewardRecipientByGithubId } from './identityService';
import {
  createPendingReward,
  PendingRewardWriteUncertainError,
} from './pendingRewardsService';
import { toPaymentExtraWallet } from './paymentExtra';
import { positiveIntFromEnv } from './envNumbers';

const TREASURY_DISPLAY_NAME = 'Automation';
const GITHUB_REWARD_EVENT_TYPES = [
  'githubPrMerged',
  'githubIssueClosed',
  'githubReviewSubmitted',
] as const;

type GithubRewardEventType = (typeof GITHUB_REWARD_EVENT_TYPES)[number];

function isGithubRewardEventType(
  value: unknown,
): value is GithubRewardEventType {
  return (
    typeof value === 'string' &&
    (GITHUB_REWARD_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export class RewardError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

/**
 * The treasury payment, or the pending-reward write, was sent but its outcome
 * is unknown: it may have taken effect. Never retried automatically; an
 * operator reconciles it.
 */
export class RewardPaymentUncertainError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RewardPaymentUncertainError';
  }
}

export interface RewardRequest {
  recipient: string; // external identity, e.g. GitHub login (label only)
  recipientId: string; // stable GitHub numeric user id — never the login
  eventType: GithubRewardEventType;
  repo: string; // owner/repo, checked against the connected-repos allowlist
  reason: string;
  source: 'github';
}

export interface ResolvedRewardRequest {
  recipient: string;
  recipientId?: string;
  amountSats: number;
  eventType?: string;
  repo?: string;
  reason: string;
  source: string;
}

export function parseRewardRequest(body: unknown): RewardRequest {
  const {
    recipient,
    recipientId,
    amountSats,
    eventType,
    repo,
    reason,
    source,
  } = (body ?? {}) as Record<string, unknown>;
  if (typeof recipient !== 'string' || recipient.trim().length === 0) {
    throw new RewardError('recipient must be a non-empty string', 400);
  }
  const normalizedRecipientId = normalizeGithubId(recipientId);
  if (normalizedRecipientId === null) {
    throw new RewardError(
      'recipientId must be a positive GitHub integer id',
      400,
    );
  }
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new RewardError('repo must use the owner/repository format', 400);
  }
  if (amountSats !== undefined) {
    throw new RewardError(
      'amountSats is not accepted; use a configured eventType',
      400,
    );
  }
  if (!isGithubRewardEventType(eventType)) {
    throw new RewardError(
      `eventType must be one of: ${GITHUB_REWARD_EVENT_TYPES.join(', ')}`,
      400,
    );
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new RewardError('reason must be a non-empty string', 400);
  }
  if (source !== 'github') {
    throw new RewardError('source must be github', 400);
  }
  return {
    recipient: recipient.trim(),
    // GitHub ids are numbers over the wire; store as a string to match the identity store's key
    recipientId: normalizedRecipientId,
    eventType,
    repo,
    reason: reason.trim(),
    source,
  };
}

function normalizeGithubId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    return value;
  }
  return null;
}

// This is what makes "connect several repos" have real effect.
export async function assertRepoConnected(repo: string): Promise<void> {
  const { repos } = await getAutomations();
  if (!repos.includes(repo)) {
    throw new RewardError(`repo '${repo}' is not connected`, 403);
  }
}

function isPositiveInteger(amountSats: unknown): amountSats is number {
  return (
    typeof amountSats === 'number' &&
    Number.isInteger(amountSats) &&
    amountSats > 0
  );
}

// Configured rewards fail closed when a portal value is malformed or above the cap.
function isValidRewardAmount(amountSats: unknown): amountSats is number {
  return isPositiveInteger(amountSats) && amountSats <= maxAmountSats();
}

export async function resolveAmountSats(
  request: RewardRequest,
): Promise<number> {
  const eventType = request.eventType;
  const configKey = `${eventType}Sats`;
  const rewardAmounts = await getRewardAmounts();
  const amountSats = Object.prototype.hasOwnProperty.call(
    rewardAmounts,
    configKey,
  )
    ? rewardAmounts[configKey]
    : undefined;
  if (amountSats === undefined) {
    throw new RewardError(
      `no configured amount for eventType '${eventType}'`,
      400,
    );
  }
  if (!isValidRewardAmount(amountSats)) {
    throw new Error(
      `configured amount for '${configKey}' is invalid: ${amountSats}`,
    );
  }
  return amountSats;
}

// 10000 matches the portal's documented default for this variable.
// Parsed by the shared strict parser so the bot and the portal backend agree on
// what a valid REWARDS_MAX_AMOUNT_SATS is — one variable, one validity.
function maxAmountSats(): number {
  return positiveIntFromEnv('REWARDS_MAX_AMOUNT_SATS', 10000);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

// Resolve the recipient to an LNbits user through the identity graph, keyed on the
// stable GitHub id. A recipient who hasn't linked their GitHub yet returns null so
// the caller holds the reward pending instead of dropping the recognition.
async function resolveRecipientUserId(
  reward: ResolvedRewardRequest,
): Promise<string | null> {
  if (!reward.recipientId) {
    throw new RewardError(
      'recipientId is required to resolve the recipient',
      400,
    );
  }
  const resolvedRecipient = await resolveRewardRecipientByGithubId(
    reward.recipientId,
  );
  if (!resolvedRecipient) {
    return null;
  }
  return resolvedRecipient.lnbitsUserId;
}

/**
 * Pays a configured reward from the treasury, or queues it in the portal when
 * the recipient has not linked GitHub yet.
 *
 * @throws RewardPaymentUncertainError once the payment or pending-reward
 *   request has left this process and its outcome is unknown; never retry it
 * @throws RewardError or Error for failures known to happen before that,
 *   which a retry may safely repeat
 */
export async function payReward(
  reward: ResolvedRewardRequest,
): Promise<{ paymentHash: string } | { pending: true }> {
  const treasuryAdminKey = requiredEnv('REWARDS_TREASURY_ADMINKEY');

  const userId = await resolveRecipientUserId(reward);
  if (userId === null) {
    try {
      await createPendingReward({
        provider: 'github',
        providerId: reward.recipientId as string,
        recipientLabel: reward.recipient,
        amountSats: reward.amountSats,
        reason: reward.reason,
        source: reward.source,
      });
    } catch (error) {
      // The portal may have stored it. A queued reward is paid when the
      // recipient links, so a second copy would pay twice: never retry it.
      if (error instanceof PendingRewardWriteUncertainError) {
        throw new RewardPaymentUncertainError(
          'The pending reward write failed after being sent to the portal.',
          error,
        );
      }
      throw error;
    }
    return { pending: true };
  }

  const wallets = await getUserWalletsByUserId(userId);
  if (!Array.isArray(wallets)) {
    throw new Error(`Could not read the wallets for LNbits user ${userId}`);
  }

  const privateWallet = wallets.find(wallet => wallet.name === 'Private');
  if (!privateWallet) {
    throw new Error(`LNbits user ${userId} has no Private wallet`);
  }

  // Shape the feed and transaction log read. The recipient wallet goes
  // through the same projection SendZap uses, so no keys are persisted.
  const extra = {
    tag: 'zap',
    automation: true,
    eventType: reward.eventType,
    repo: reward.repo,
    source: reward.source,
    // The bot holds only the treasury wallet's admin key, not its wallet
    // object, and a lookup just to fill id/name/user would put an LNbits round
    // trip on the payment path for fields no reader uses (see SOLUTION_DESIGN).
    from: { displayName: TREASURY_DISPLAY_NAME },
    to: toPaymentExtraWallet(
      privateWallet,
      'recipient Private',
      reward.recipient,
    ),
  };

  const paymentRequest = await createInvoice(
    privateWallet.inkey,
    privateWallet.id,
    reward.amountSats,
    reward.reason,
    extra,
  );
  // createInvoice returns the caught error object instead of throwing (legacy)
  if (typeof paymentRequest !== 'string') {
    throw new Error(`creating reward invoice failed: ${paymentRequest}`);
  }

  // From here the request has left this process, so a failure no longer
  // means "nothing was paid". Only the errors above may be retried.
  let result;
  try {
    result = await payInvoice(treasuryAdminKey, paymentRequest, extra);
  } catch (error) {
    throw new RewardPaymentUncertainError(
      'The reward payment request failed after being sent to LNbits.',
      error,
    );
  }
  if (!result?.payment_hash) {
    throw new RewardPaymentUncertainError(
      'The reward payment returned no payment hash, so it cannot be confirmed.',
    );
  }
  return { paymentHash: result.payment_hash };
}
