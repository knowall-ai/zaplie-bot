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

// Prefill only: a reaction is a one-tap gesture, so keep the amount small.
export const ZAP_REACTION_DEFAULT_SATS = 21;

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
