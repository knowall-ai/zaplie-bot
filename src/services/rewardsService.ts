import { getUserWallets, getUsers, createInvoice, payInvoice } from './lnbitsService';
import { getRewardAmounts } from './fetchRewardAmounts';
import { getAutomations } from './fetchAutomations';
import { resolvePersonAadByGithubId } from './identityService';
import { createPendingReward } from './pendingRewardsService';

const TREASURY_DISPLAY_NAME = 'Automation';

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
  recipientId?: string; // stable numeric provider id, e.g. GitHub user id — never the login
  amountSats?: number;
  eventType?: string;
  repo?: string; // owner/repo, checked against the connected-repos allowlist
  reason: string;
  source: string;
}

export interface ResolvedRewardRequest {
  recipient: string;
  recipientId?: string;
  amountSats: number;
  reason: string;
  source: string;
}

export function parseRewardRequest(body: unknown): RewardRequest {
  const { recipient, recipientId, amountSats, eventType, repo, reason, source } =
    (body ?? {}) as Record<string, unknown>;
  if (typeof recipient !== 'string' || recipient.length === 0) {
    throw new RewardError('recipient must be a non-empty string', 400);
  }
  if (
    recipientId !== undefined &&
    ((typeof recipientId !== 'string' && typeof recipientId !== 'number') ||
      String(recipientId).length === 0)
  ) {
    throw new RewardError(
      'recipientId must be a non-empty string or number',
      400,
    );
  }
  if (repo !== undefined && (typeof repo !== 'string' || repo.length === 0)) {
    throw new RewardError('repo must be a non-empty string', 400);
  }
  if (amountSats !== undefined) {
    validateAmountSats(amountSats);
  } else if (typeof eventType !== 'string' || eventType.length === 0) {
    throw new RewardError('either amountSats or eventType is required', 400);
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new RewardError('reason must be a non-empty string', 400);
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new RewardError('source must be a non-empty string', 400);
  }
  return {
    recipient,
    // GitHub ids are numbers over the wire; store as a string to match the identity store's key
    recipientId: recipientId !== undefined ? String(recipientId) : undefined,
    // already validated above; cast reflects that, not new trust
    amountSats: amountSats as number | undefined,
    // eventType is unused when amountSats is set, so a malformed one is dropped, not a 400
    eventType: typeof eventType === 'string' ? eventType : undefined,
    repo: typeof repo === 'string' ? repo : undefined,
    reason,
    source,
  };
}

// This is what makes "connect several repos" have real effect.
export async function assertRepoConnected(repo: string | undefined): Promise<void> {
  if (!repo) {
    throw new RewardError('repo is required', 400);
  }
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

// single cap-check predicate shared with resolveAmountSats so the two amount sources can't drift
function isValidRewardAmount(amountSats: unknown): amountSats is number {
  return isPositiveInteger(amountSats) && amountSats <= maxAmountSats();
}

function validateAmountSats(amountSats: unknown): asserts amountSats is number {
  if (!isPositiveInteger(amountSats)) {
    throw new RewardError('amountSats must be a positive integer', 400);
  }
  if (!isValidRewardAmount(amountSats)) {
    throw new RewardError(
      `amountSats exceeds the per-reward cap of ${maxAmountSats()}`,
      400,
    );
  }
}

export async function resolveAmountSats(
  request: RewardRequest,
): Promise<number> {
  if (request.amountSats !== undefined) {
    return request.amountSats;
  }

  // parseRewardRequest guarantees eventType is set when amountSats is absent.
  const eventType = request.eventType as string;
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
  const personAad = await resolvePersonAadByGithubId(reward.recipientId);
  if (!personAad) {
    return null;
  }
  const users = await getUsers(process.env.LNBITS_ADMINKEY as string, {
    aadObjectId: personAad,
  });
  if (users.length === 0) {
    throw new Error(`linked person ${personAad} has no LNbits user`);
  }
  return users[0].id;
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

  const adminKey = process.env.LNBITS_ADMINKEY;
  if (!adminKey) {
    throw new Error('LNBITS_ADMINKEY is not set');
  }

  // getUserWallets ignores adminKey; it authenticates via LNBITS_USERNAME/PASSWORD
  const wallets = await getUserWallets(adminKey, userId);
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
    source: reward.source,
    from: { displayName: TREASURY_DISPLAY_NAME },
    to: {
      id: privateWallet.id,
      name: privateWallet.name,
      user: privateWallet.user,
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
