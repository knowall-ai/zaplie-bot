// agentTools.ts
//
// Read-only tools for the Foundry conversational agent. Each returns structured
// data (not a chat activity) so the agent decides how to phrase the reply.

import { TurnContext } from 'botbuilder';
import { ToolDefinition } from '../services/foundryAgentService';
import { getUserWallets } from '../services/lnbitsService';
import {
  getRecentZaps,
  getZapLeaderboard,
} from '../services/zapHistoryService';
import { getRecentMeetings, getRelevantPeople } from '../services/graphService';
import {
  CONNECT_CALENDAR_COMMAND,
  getStoredGraphToken,
} from './connectCalendarCommand';

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
    'Get the team leaderboard, ranked by the sats each teammate has zapped to others ' +
    'out of their Allowance wallet. Private wallet balances are never ranked.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const entries = await getZapLeaderboard();
    return {
      rewardLabel,
      leaderboard: entries.map(entry => ({
        displayName: entry.user.displayName,
        zappedSats: entry.zappedSats,
      })),
    };
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

export function createReadOnlyTools(): ToolDefinition[] {
  return [
    getMyBalanceTool,
    getLeaderboardTool,
    getRecentActivityTool,
    ...(process.env.GRAPH_CONNECTION_NAME
      ? [getRecentMeetingsTool, getFrequentCollaboratorsTool]
      : []),
  ];
}
