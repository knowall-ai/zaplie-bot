import { getUserWallets, createInvoice, payInvoice } from './lnbitsService';
import { getRewardAmounts } from './fetchRewardAmounts';

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
  recipient: string; // external identity, e.g. GitHub login
  amountSats?: number;
  eventType?: string;
  reason: string;
  source: string;
}

export interface ResolvedRewardRequest {
  recipient: string;
  amountSats: number;
  reason: string;
  source: string;
}

export function parseRewardRequest(body: unknown): RewardRequest {
  const { recipient, amountSats, eventType, reason, source } = (body ??
    {}) as Record<string, unknown>;
  if (typeof recipient !== 'string' || recipient.length === 0) {
    throw new RewardError('recipient must be a non-empty string', 400);
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
    // already validated above; cast reflects that, not new trust
    amountSats: amountSats as number | undefined,
    // eventType is unused when amountSats is set, so a malformed one is dropped, not a 400
    eventType: typeof eventType === 'string' ? eventType : undefined,
    reason,
    source,
  };
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

function lookupLnbitsUserId(githubLogin: string): string {
  const map = JSON.parse(requiredEnv('REWARDS_GITHUB_USER_MAP'));
  // hasOwnProperty so "constructor" etc. cannot resolve via Object.prototype
  const userId = Object.prototype.hasOwnProperty.call(map, githubLogin)
    ? map[githubLogin]
    : undefined;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new RewardError(
      `no LNbits user mapped for recipient "${githubLogin}"`,
      404,
    );
  }
  return userId;
}

export async function payReward(
  reward: ResolvedRewardRequest,
): Promise<{ paymentHash: string }> {
  const treasuryAdminKey = requiredEnv('REWARDS_TREASURY_ADMINKEY');

  const userId = lookupLnbitsUserId(reward.recipient);
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
