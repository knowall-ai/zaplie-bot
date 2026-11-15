import { createHash } from 'crypto';
import {
  payReward as payRewardThroughPortal,
  PaymentNotSentError,
  PaymentOutcomeUncertainError,
} from './peopleDirectory';
import { getRewardConfig } from './fetchRewardPolicy';
import { getAutomations } from './fetchAutomations';
import {
  ResolvedRewardRecipient,
  resolveRewardRecipientByGithubId,
} from './identityService';
import {
  createPendingReward,
  PendingRewardWriteUncertainError,
} from './pendingRewardsService';
import { positiveIntFromEnv } from './envNumbers';

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
  // Label names on the PR at merge. Not part of the reward's identity: a
  // relabel after the first delivery changes nothing (the ledger replays).
  labels: string[];
}

/** The configured amount for one reward and how it was made up. */
export interface RewardAmount {
  amountSats: number;
  baseSats: number;
  bonusSats: number;
  level: string | null;
}

export interface ResolvedRewardRequest {
  recipient: string;
  recipientId?: string;
  amountSats: number;
  eventType?: string;
  repo?: string;
  reason: string;
  source: string;
  baseSats?: number;
  bonusSats?: number;
  level?: string | null;
}

const LABEL_PATTERN = /^[ -~]{1,50}$/;
const MAX_LABELS = 50;

function parseLabels(labels: unknown): string[] {
  if (labels === undefined) {
    return [];
  }
  if (
    !Array.isArray(labels) ||
    labels.length > MAX_LABELS ||
    !labels.every(
      label => typeof label === 'string' && LABEL_PATTERN.test(label),
    )
  ) {
    throw new RewardError(
      `labels must be up to ${MAX_LABELS} printable ASCII strings of 1-50 characters`,
      400,
    );
  }
  return labels as string[];
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
    labels,
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
  const parsedLabels = parseLabels(labels);
  return {
    recipient: recipient.trim(),
    // GitHub ids are numbers over the wire; store as a string to match the identity store's key
    recipientId: normalizedRecipientId,
    eventType,
    repo,
    reason: reason.trim(),
    source,
    labels: parsedLabels,
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

/**
 * The level bonus for a set of labels: the largest configured bonus whose
 * `labelPrefix + level` is on the PR. One bonus, never a sum; labels are
 * matched case-insensitively, as GitHub treats them.
 */
export function selectLevel(
  labels: readonly string[],
  rule: { labelPrefix: string; bonuses: Record<string, number> } | undefined,
): { level: string; bonusSats: number } | null {
  if (!rule) {
    return null;
  }
  const present = new Set(labels.map(label => label.toLowerCase()));
  let best: { level: string; bonusSats: number } | null = null;
  for (const [level, bonusSats] of Object.entries(rule.bonuses)) {
    if (
      present.has(`${rule.labelPrefix}${level}`.toLowerCase()) &&
      (best === null || bonusSats > best.bonusSats)
    ) {
      best = { level, bonusSats };
    }
  }
  return best;
}

/**
 * The amount for a reward, from the admin's settings only: the person's base
 * override for this event, else the org base, plus the bonus for the highest
 * level label on the PR. An unlinked recipient (null) gets the org base.
 *
 * @throws RewardError 503 when no base is configured for the event
 * @throws Error when the total is not a positive integer within
 *   REWARDS_MAX_AMOUNT_SATS, or the portal policy is unreadable
 */
export async function resolveAmountSats(
  request: RewardRequest,
  recipient: ResolvedRewardRecipient | null,
): Promise<RewardAmount> {
  const eventType = request.eventType;
  const configKey = `${eventType}Sats`;
  const { rewardAmounts, rewardPolicy } = await getRewardConfig();

  const personAad = recipient?.personAad.toLowerCase();
  const override =
    personAad !== undefined &&
    Object.prototype.hasOwnProperty.call(rewardPolicy.overrides, personAad)
      ? rewardPolicy.overrides[personAad][eventType]
      : undefined;
  const orgBase = Object.prototype.hasOwnProperty.call(rewardAmounts, configKey)
    ? rewardAmounts[configKey]
    : undefined;
  const baseSats = override?.baseSats ?? orgBase;
  if (baseSats === undefined) {
    // Not the caller's fault: an admin has not set this amount yet, so the
    // service is unavailable for this event until they do (fail closed).
    throw new RewardError(
      `no configured amount for eventType '${eventType}'`,
      503,
    );
  }

  const selected = selectLevel(request.labels, rewardPolicy.levels[eventType]);
  const bonusSats = selected?.bonusSats ?? 0;
  const amountSats = baseSats + bonusSats;
  if (!isValidRewardAmount(amountSats)) {
    throw new Error(
      `configured amount for '${configKey}' is invalid: ${amountSats}`,
    );
  }
  return {
    amountSats,
    baseSats,
    bonusSats,
    level: selected?.level ?? null,
  };
}

// 10000 matches the portal's documented default for this variable.
// Parsed by the shared strict parser so the bot and the portal backend agree on
// what a valid REWARDS_MAX_AMOUNT_SATS is — one variable, one validity.
function maxAmountSats(): number {
  return positiveIntFromEnv('REWARDS_MAX_AMOUNT_SATS', 10000);
}

/**
 * Resolves the recipient through the identity graph, keyed on the stable
 * GitHub id. A recipient who hasn't linked GitHub yet is null, so the reward
 * is held pending instead of dropped.
 *
 * Runs before the amount, because a person's base override depends on who
 * they are. Any error here happens before payment, so a retry is safe.
 */
export async function resolveRewardRecipient(request: {
  recipientId?: string;
}): Promise<ResolvedRewardRecipient | null> {
  if (!request.recipientId) {
    throw new RewardError(
      'recipientId is required to resolve the recipient',
      400,
    );
  }
  return resolveRewardRecipientByGithubId(request.recipientId);
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
  recipient: ResolvedRewardRecipient | null,
  // Stable per delivery (processReward passes a hash of its ledger key), so
  // the portal pays one reward at most once however often it is retried.
  idempotencyKey?: string,
): Promise<{ paymentHash: string } | { pending: true }> {
  if (recipient === null) {
    if (!reward.recipientId) {
      throw new RewardError(
        'recipientId is required to queue a pending reward',
        400,
      );
    }
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
      // The portal may have stored it. A queued reward is paid by hand later,
      // so a second copy would pay twice: never retry it.
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

  // The portal pays from the Treasury (over NWC) to the recipient's
  // registered address, resolved from the directory by Entra id, and records
  // it for the feed and the automation stats. The bot holds no Treasury
  // credential.
  const key =
    idempotencyKey ??
    createHash('sha256')
      .update(JSON.stringify({ reward, personAad: recipient.personAad }))
      .digest('hex');
  try {
    const paymentHash = await payRewardThroughPortal({
      recipientOid: recipient.personAad,
      recipientLabel: reward.recipient,
      amountSats: reward.amountSats,
      memo: reward.reason,
      // How the amount was made up: numbers and a short level name, no names.
      reward: {
        ...(reward.eventType !== undefined
          ? { eventType: reward.eventType }
          : {}),
        ...(reward.repo !== undefined ? { repo: reward.repo } : {}),
        source: reward.source,
        ...(reward.baseSats !== undefined ? { baseSats: reward.baseSats } : {}),
        ...(reward.bonusSats !== undefined
          ? { bonusSats: reward.bonusSats }
          : {}),
        ...(reward.level ? { level: reward.level } : {}),
      },
      idempotencyKey: key,
    });
    return { paymentHash };
  } catch (error) {
    // A refusal before payment (no receive address, Treasury budget used
    // up) is a plain error a retry may repeat; anything else may have paid.
    if (error instanceof PaymentNotSentError) {
      throw error;
    }
    throw new RewardPaymentUncertainError(
      error instanceof PaymentOutcomeUncertainError
        ? error.message
        : 'The reward payment request failed after being sent to the portal.',
      error,
    );
  }
}
