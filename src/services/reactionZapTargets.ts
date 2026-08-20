import { MAX_ZAP_SATS } from '../commands/zapBudget';

// Maps bot-sent zap cards to their pre-filled recipient so a ⚡ reaction on
// the card can pay that recipient. Teams only forwards reactions for messages
// the bot itself sent, so this registry is the entire phase-1 surface.
// In-memory and bounded: after a restart old cards simply stop reacting,
// which fails safe (no payment). Durability is not needed because the zap
// ledger still deduplicates any card that does get zapped twice.
const MAX_TARGETS = 500;

// Teams sends the expanded emoji reaction ids to bots on newer clients
// (⚡ is 26a1_highvoltagesymbol); older clients may still map to the six
// legacy types, so this set is the single place to widen if the spike
// logging shows something else arriving.
export const ZAP_REACTION_TYPES = new Set(['26a1_highvoltagesymbol', '⚡']);

// A reaction is a one-tap gesture with no card to edit, so the default stays
// small; operators raise it with ZAP_REACTION_SATS.
export const ZAP_REACTION_DEFAULT_SATS = 21;

// Read per reaction rather than at import so a misconfigured value surfaces on
// the next zap instead of silently paying the default forever.
export function zapReactionSats(): number {
  const configured = process.env.ZAP_REACTION_SATS;
  if (configured === undefined || configured.trim() === '') {
    return ZAP_REACTION_DEFAULT_SATS;
  }
  const amount = Number(configured);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_ZAP_SATS) {
    throw new Error(
      `ZAP_REACTION_SATS must be a whole number between 1 and ${MAX_ZAP_SATS}, received: ${configured}`,
    );
  }
  return amount;
}

interface ZapTarget {
  receiverId: string;
}

const targets = new Map<string, ZapTarget>();

const keyFor = (conversationId: string, activityId: string): string =>
  `${conversationId}:${activityId}`;

export function registerZapTarget(
  conversationId: string | undefined,
  activityId: string | undefined,
  receiverId: string,
): void {
  if (!conversationId || !activityId || !receiverId) {
    return;
  }
  if (targets.size >= MAX_TARGETS) {
    const oldest = targets.keys().next().value;
    if (oldest !== undefined) {
      targets.delete(oldest);
    }
  }
  targets.set(keyFor(conversationId, activityId), { receiverId });
}

export function getZapTarget(
  conversationId: string | undefined,
  activityId: string | undefined,
): ZapTarget | undefined {
  if (!conversationId || !activityId) {
    return undefined;
  }
  return targets.get(keyFor(conversationId, activityId));
}

export function resetZapTargetsForTests(): void {
  targets.clear();
}
