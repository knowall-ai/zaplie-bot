// agentTools.ts
//
// Read-only tools for the Foundry conversational agent. Each returns structured
// data (not a chat activity) so the agent decides how to phrase the reply.

import { TurnContext } from 'botbuilder';
import { ToolDefinition } from '../services/foundryAgentService';
import {
  getUserWallets,
  getWallets,
  getUsers,
} from '../services/lnbitsService';
import { getRecentZaps } from '../services/zapHistoryService';
import { getAchievementsFor } from '../services/fetchAchievements';

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
  handler: async () => {
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
      }))
      .sort((a, b) => b.balanceSats - a.balanceSats);
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

const getMyAchievementsTool: ToolDefinition = {
  name: 'get_my_achievements',
  description:
    "Get the current user's achievement progress computed from real LNbits zap history. " +
    'These are Zaplie milestones, not stored or published Nostr badges.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_args, turnContext: TurnContext) => {
    const user = turnContext.turnState.get('user') as User;
    return { rewardLabel, ...(await getAchievementsFor(user.aadObjectId)) };
  },
};

export function createReadOnlyTools(): ToolDefinition[] {
  return [
    getMyBalanceTool,
    getLeaderboardTool,
    getRecentActivityTool,
    getMyAchievementsTool,
  ];
}
