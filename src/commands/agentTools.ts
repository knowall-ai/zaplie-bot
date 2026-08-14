// agentTools.ts
//
// Tools for the Foundry conversational agent. Read tools return structured
// data; propose_zap posts an editable confirmation card but never pays it.

import { CardFactory, MessageFactory, TurnContext } from 'botbuilder';
import { ToolDefinition } from '../services/foundryAgentService';
import {
  getUserWallets,
  getWallets,
  getUsers,
} from '../services/lnbitsService';
import { getRecentZaps } from '../services/zapHistoryService';
import { MAX_ZAP_SATS } from './zapBudget';
import { validateSelfZap } from './zapRecipient';
import { createZapCard } from './sendZapCommand';

const adminKey = process.env.LNBITS_ADMINKEY as string;
const rewardLabel = process.env.LNBITS_POINTS_LABEL as string;

const toSats = (balanceMsat: number): number => Math.floor(balanceMsat / 1000);

const getMyBalanceTool: ToolDefinition = {
  name: 'get_my_balance',
  description: "Get the current user's Allowance and Private wallet balances.",
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_args, turnContext: TurnContext) => {
    const user = turnContext.turnState.get('user') as User;
    const wallets = await getUserWallets(adminKey, user.id);
    return {
      rewardLabel,
      wallets: wallets.map(wallet => ({
        name: wallet.name,
        balanceSats: toSats(wallet.balance_msat),
      })),
    };
  },
};

const getLeaderboardTool: ToolDefinition = {
  name: 'get_leaderboard',
  description:
    "Get the team leaderboard, ranked by each teammate's Private wallet balance.",
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_args, turnContext: TurnContext) => {
    const currentUser = turnContext.turnState.get('user') as User;
    const [privateWallets, users] = await Promise.all([
      getWallets(adminKey, 'Private'),
      getUsers(adminKey, null),
    ]);
    const displayNameByUserId = new Map(
      users.map(user => [user.id, user.displayName]),
    );
    const leaderboard = privateWallets
      .map(wallet => ({
        displayName: displayNameByUserId.get(wallet.user) ?? 'Unknown',
        balanceSats: toSats(wallet.balance_msat),
        isCurrentUser: wallet.user === currentUser.id,
      }))
      .sort((a, b) => b.balanceSats - a.balanceSats);
    return { rewardLabel, leaderboard };
  },
};

const getRecentActivityTool: ToolDefinition = {
  name: 'get_recent_activity',
  description:
    'Get recent zaps sent across the team: who sent what to whom, how much, and why (the memo). ' +
    'Use this for "recent rewards", "why was I zapped", "team activity", or (with ' +
    'get_leaderboard) who may deserve recognition. Request limit 50 for recognition suggestions.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description:
          'Max number of recent zaps to return. Defaults to 20, capped at 50.',
      },
      onlyInvolvingMe: {
        type: 'boolean',
        description:
          'If true, only include zaps where the current user is the sender or receiver.',
      },
    },
    required: [],
  },
  handler: async (
    args: { limit?: number; onlyInvolvingMe?: boolean },
    turnContext: TurnContext,
  ) => {
    const user = turnContext.turnState.get('user') as User;
    const limit =
      typeof args.limit === 'number'
        ? Math.min(Math.max(args.limit, 1), 50)
        : 20;
    const activity = await getRecentZaps({
      limit,
      userAadObjectId: args.onlyInvolvingMe ? user.aadObjectId : undefined,
    });
    return {
      rewardLabel,
      activity: activity.map(entry => ({
        from: entry.from?.displayName || 'Unknown',
        to: entry.to?.displayName || 'Unknown',
        amountSats: entry.amountSats,
        memo: entry.memo,
        time: entry.time.toISOString(),
      })),
    };
  },
};

const proposeZapTool: ToolDefinition = {
  name: 'propose_zap',
  description:
    'Post an editable zap confirmation card for an explicit user request. This only proposes ' +
    'a zap; payment requires the user to press Send Zap.',
  parameters: {
    type: 'object',
    properties: {
      recipientName: {
        type: 'string',
        description: "The teammate's display name.",
      },
      amountSats: {
        type: 'number',
        description: `Whole sats from 1 to ${MAX_ZAP_SATS}.`,
      },
      memo: {
        type: 'string',
        description: 'Why the teammate is being recognised.',
      },
    },
    required: ['recipientName', 'amountSats', 'memo'],
  },
  handler: async (
    args: { recipientName?: string; amountSats?: number; memo?: string },
    turnContext: TurnContext,
  ) => {
    const { recipientName, amountSats, memo } = args;
    if (
      typeof recipientName !== 'string' ||
      typeof memo !== 'string' ||
      typeof amountSats !== 'number' ||
      !recipientName.trim() ||
      !memo.trim() ||
      !Number.isInteger(amountSats) ||
      amountSats < 1 ||
      amountSats > MAX_ZAP_SATS
    ) {
      return {
        proposed: false,
        reason: `Recipient, reason, and a whole amount from 1 to ${MAX_ZAP_SATS} sats are required.`,
      };
    }

    const sender = turnContext.turnState.get('user') as User | undefined;
    if (!sender) {
      throw new Error(
        'The current user is unavailable, so no zap was proposed.',
      );
    }

    const senderWallets = await getUserWallets(adminKey, sender.id);
    const allowance = senderWallets.find(w => w.name === 'Allowance');
    if (!allowance) {
      throw new Error(
        `${sender.displayName} has no Allowance wallet, so no zap was proposed.`,
      );
    }
    const allowanceSats = toSats(allowance.balance_msat);
    if (amountSats > allowanceSats) {
      return {
        proposed: false,
        reason: `The requested ${amountSats} sats exceeds the current Allowance balance of ${allowanceSats} sats.`,
      };
    }

    const users = await getUsers(adminKey, null);
    const query = recipientName.trim().toLowerCase();
    const exact = users.filter(
      user => user.displayName.toLowerCase() === query,
    );
    const matches = exact.length
      ? exact
      : users.filter(user => user.displayName.toLowerCase().includes(query));

    if (matches.length !== 1) {
      return {
        proposed: false,
        reason: matches.length
          ? `More than one teammate matches "${recipientName}".`
          : `No teammate matches "${recipientName}".`,
        candidates: matches.map(user => user.displayName),
      };
    }

    const recipient = matches[0];
    const recipientError = validateSelfZap(sender, recipient);
    if (recipientError) {
      return { proposed: false, reason: recipientError };
    }

    const card = await createZapCard(sender, rewardLabel, {
      receiverId: recipient.id,
      message: memo.trim(),
      amountSats,
    });
    await turnContext.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(card)),
    );
    return {
      proposed: true,
      recipient: recipient.displayName,
      amountSats,
      memo: memo.trim(),
    };
  },
};

export function createAgentTools(): ToolDefinition[] {
  return [
    getMyBalanceTool,
    getLeaderboardTool,
    getRecentActivityTool,
    proposeZapTool,
  ];
}
