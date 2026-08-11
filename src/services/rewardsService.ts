import { getUserWalletsByUserId, createInvoice, payInvoice } from './lnbitsService';
import { getRewardAmounts } from './fetchRewardAmounts';
import { getAutomations } from './fetchAutomations';
import { resolveRewardRecipientByGithubId } from './identityService';
import { createPendingReward } from './pendingRewardsService';

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
  const { recipient, recipientId, amountSats, eventType, repo, reason, source } =
    (body ?? {}) as Record<string, unknown>;
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
  if (
    typeof repo !== 'string' ||
    !/^[^/\s]+\/[^/\s]+$/.test(repo)
  ) {
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

// 10000 matches the interactive zap card's ceiling
function maxAmountSats(): number {
  const cap = Number(process.env.REWARDS_MAX_AMOUNT_SATS ?? 10000);
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new Error('REWARDS_MAX_AMOUNT_SATS must be a positive integer');
  }
  return cap;
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
    throw new RewardError('recipientId is required to resolve the recipient', 400);
  }
  const resolvedRecipient = await resolveRewardRecipientByGithubId(reward.recipientId);
  if (!resolvedRecipient) {
    return null;
  }
  return resolvedRecipient.lnbitsUserId;
}

export async function payReward(
  reward: ResolvedRewardRequest,
): Promise<{ paymentHash: string } | { pending: true }> {
  const treasuryAdminKey = requiredEnv('REWARDS_TREASURY_ADMINKEY');

  const userId = await resolveRecipientUserId(reward);
  if (userId === null) {
    await createPendingReward({
      provider: 'github',
      providerId: reward.recipientId as string,
      recipientLabel: reward.recipient,
      amountSats: reward.amountSats,
      reason: reward.reason,
      source: reward.source,
    });
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

  // shape the feed/transaction log read; unlike SendZap, no wallet keys persisted
  const extra = {
    tag: 'zap',
    automation: true,
    eventType: reward.eventType,
    repo: reward.repo,
    source: reward.source,
    from: { displayName: TREASURY_DISPLAY_NAME },
    to: {
      id: privateWallet.id,
      name: privateWallet.name,
      user: privateWallet.user,
      displayName: reward.recipient,
    },
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

  const result = await payInvoice(treasuryAdminKey, paymentRequest, extra);
  if (!result || !result.payment_hash) {
    throw new Error(
      `paying reward invoice failed: ${JSON.stringify(result)}`,
    );
  }
  return { paymentHash: result.payment_hash };
}
