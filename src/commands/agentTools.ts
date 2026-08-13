// agentTools.ts
//
// Tools for the Foundry conversational agent. Read tools return structured
// data (not a chat activity) so the agent decides how to phrase the reply;
// propose_zap only posts a confirmation card (see ToolDefinition.sideEffect).

import { TurnContext, CardFactory, MessageFactory } from 'botbuilder';
import { ToolDefinition } from '../services/foundryAgentService';
import { getUserWallets, getUsers } from '../services/lnbitsService';
import { getRecentZaps } from '../services/zapHistoryService';
import { getRecentMeetings, getRelevantPeople } from '../services/graphService';
import {
  CONNECT_CALENDAR_COMMAND,
  getStoredGraphToken,
} from './connectCalendarCommand';
import { createZapCard } from './sendZapCommand';
import { MAX_ZAP_SATS } from './zapBudget';

const adminKey = process.env.LNBITS_ADMINKEY as string;
const rewardLabel = process.env.LNBITS_POINTS_LABEL as string;
const ALLOWANCE_WALLET_NAME = 'Allowance';
const PRIVATE_WALLET_NAME = 'Private';

const toSats = (balanceMsat: number): number => Math.floor(balanceMsat / 1000);

const isBalanceWallet = (wallet: Wallet): boolean =>
  wallet.name === ALLOWANCE_WALLET_NAME || wallet.name === PRIVATE_WALLET_NAME;

const DAYS_PARAMETER = {
  type: 'number',
  description: 'Look-back window in days. Defaults to 7, capped at 30.',
};

const clampDays = (days?: number): number =>
  typeof days === 'number' && Number.isFinite(days)
    ? Math.min(Math.max(Math.floor(days), 1), 30)
    : 7;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getMyBalanceTool: ToolDefinition = {
  name: 'get_my_balance',
  description: "Get the current user's Allowance and Private wallet balances.",
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_args, turnContext: TurnContext) => {
    const user = turnContext.turnState.get('user') as User;
    const wallets = await getUserWallets(adminKey, user.id);
    return {
      rewardLabel,
      wallets: wallets.filter(isBalanceWallet).map(wallet => ({
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
  handler: async () => {
    const users = await getUsers(adminKey, null);
    const walletsByUser = await Promise.all(
      users.map(async user => ({
        user,
        wallets: await getUserWallets(adminKey, user.id),
      })),
    );

    const leaderboard: { displayName: string; balanceSats: number }[] = [];
    for (const { user, wallets } of walletsByUser) {
      const privateWallet = wallets.find(
        wallet => wallet.name === PRIVATE_WALLET_NAME,
      );
      if (privateWallet) {
        leaderboard.push({
          displayName: user.displayName,
          balanceSats: toSats(privateWallet.balance_msat),
        });
      }
    }

    leaderboard.sort((a, b) => b.balanceSats - a.balanceSats);
    return { rewardLabel, leaderboard };
  },
};

const getRecentActivityTool: ToolDefinition = {
  name: 'get_recent_activity',
  description:
    'Get recent zaps sent across the team: who sent what to whom, how much, and why (the memo). ' +
    'Use this for "recent rewards", "why was I zapped", or "team activity" questions.',
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
  handler: async (args: unknown, turnContext: TurnContext) => {
    const options = isRecord(args) ? args : {};
    const user = turnContext.turnState.get('user') as User;
    const limit =
      typeof options.limit === 'number'
        ? Math.min(Math.max(options.limit, 1), 50)
        : 20;
    const activity = await getRecentZaps({
      limit,
      userAadObjectId:
        options.onlyInvolvingMe === true ? user.aadObjectId : undefined,
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

const getRecentMeetingsTool: ToolDefinition = {
  name: 'get_recent_meetings',
  description:
    "Get the current user's recent meetings using delegated, read-only Microsoft Graph access. " +
    'Combine the result with get_recent_activity when suggesting recognition.',
  parameters: {
    type: 'object',
    properties: { days: DAYS_PARAMETER },
    required: [],
  },
  handler: async (args: { days?: number }, turnContext: TurnContext) => {
    const token = await getStoredGraphToken(turnContext);
    if (!token) {
      return {
        connected: false,
        message: `Ask the user to type "${CONNECT_CALENDAR_COMMAND}" before using work signals.`,
      };
    }
    const periodDays = clampDays(args.days);
    return {
      connected: true,
      periodDays,
      meetings: await getRecentMeetings(token, periodDays),
    };
  },
};

const getFrequentCollaboratorsTool: ToolDefinition = {
  name: 'get_frequent_collaborators',
  description:
    'Get people most relevant to the current user across Microsoft 365 communication signals. ' +
    'No message content is returned. Combine with get_recent_activity when suggesting recognition.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_args, turnContext: TurnContext) => {
    const token = await getStoredGraphToken(turnContext);
    if (!token) {
      return {
        connected: false,
        message: `Ask the user to type "${CONNECT_CALENDAR_COMMAND}" before using work signals.`,
      };
    }
    return {
      connected: true,
      collaborators: await getRelevantPeople(token, 10),
    };
  },
};

const proposeZapTool: ToolDefinition = {
  name: 'propose_zap',
  description:
    'Propose sending a zap to a teammate. Posts a pre-filled confirmation card in the chat; ' +
    'nothing is paid until the user presses "Send Zap" on the card. ' +
    'Returns { proposed: true } on success, or { proposed: false, reason } when the proposal ' +
    'cannot be made (unknown/ambiguous recipient, self-zap, bad amount, insufficient balance).',
  parameters: {
    type: 'object',
    properties: {
      recipientName: {
        type: 'string',
        description:
          "The teammate's display name (or an unambiguous part of it).",
      },
      amountSats: {
        type: 'number',
        description: `Whole number of sats to send, between 1 and ${MAX_ZAP_SATS}.`,
      },
      memo: {
        type: 'string',
        description:
          'Why the recipient is being recognised. Ask the user if they gave no reason.',
      },
    },
    required: ['recipientName', 'amountSats', 'memo'],
  },
  sideEffect: true,
  handler: async (
    args: { recipientName: unknown; amountSats: unknown; memo: unknown },
    turnContext: TurnContext,
  ) => {
    const sender = turnContext.turnState.get('user') as User | undefined;
    if (!sender) {
      throw new Error(
        'propose_zap: no current user in turn state, so no zap was proposed.',
      );
    }

    const { recipientName, amountSats, memo } = args;
    if (typeof recipientName !== 'string' || recipientName.trim() === '') {
      return {
        proposed: false,
        reason: `recipientName must be a non-empty string, received: ${JSON.stringify(recipientName)}.`,
      };
    }
    if (
      typeof amountSats !== 'number' ||
      !Number.isInteger(amountSats) ||
      amountSats < 1 ||
      amountSats > MAX_ZAP_SATS
    ) {
      return {
        proposed: false,
        reason: `amountSats must be a whole number between 1 and ${MAX_ZAP_SATS}, received: ${JSON.stringify(amountSats)}.`,
      };
    }
    if (typeof memo !== 'string' || memo.trim() === '') {
      return {
        proposed: false,
        reason: `memo must be a non-empty string saying why the recipient is recognised, received: ${JSON.stringify(memo)}.`,
      };
    }

    // A live read, not the turn-state wallet snapshot: that snapshot was taken
    // at sign-in and never decrements, so it would let the agent propose zaps
    // the sender can no longer cover.
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
    const exact = users.filter(u => u.displayName.toLowerCase() === query);
    const matches = exact.length
      ? exact
      : users.filter(u => u.displayName.toLowerCase().includes(query));

    if (matches.length === 0) {
      return {
        proposed: false,
        reason: `No teammate matches "${recipientName}".`,
        teammates: users.map(u => u.displayName),
      };
    }
    if (matches.length > 1) {
      return {
        proposed: false,
        reason: `"${recipientName}" matches more than one teammate — ask the user which one they mean.`,
        candidates: matches.map(u => u.displayName),
      };
    }

    const recipient = matches[0];
    if (recipient.aadObjectId === sender.aadObjectId) {
      return {
        proposed: false,
        reason:
          'Users cannot zap themselves — the allowance is for recognising others.',
      };
    }

    const card = await createZapCard(sender, rewardLabel, {
      receiverId: recipient.id,
      message: memo,
      amountSats,
    });
    await turnContext.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(card)),
    );

    return {
      proposed: true,
      recipient: recipient.displayName,
      amountSats,
      memo,
    };
  },
};

// ensureAgent memoizes the first tool set per process, so read and propose
// tools must be registered together in a single list.
export function createAgentTools(): ToolDefinition[] {
  return [
    getMyBalanceTool,
    getLeaderboardTool,
    getRecentActivityTool,
    proposeZapTool,
    ...(process.env.GRAPH_CONNECTION_NAME
      ? [getRecentMeetingsTool, getFrequentCollaboratorsTool]
      : []),
  ];
}
