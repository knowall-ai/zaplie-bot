// agentTools.ts
//
// Tools for the Foundry conversational agent. Read tools return structured
// data (not a chat activity) so the agent decides how to phrase the reply;
// propose_zap only posts a confirmation card (see ToolDefinition.sideEffect).

import { TurnContext, CardFactory, MessageFactory } from 'botbuilder';
import { ToolDefinition } from '../services/foundryAgentService';
import { getUserWallets, getUsers } from '../services/lnbitsService';
import {
  getZapActivity,
  getZapLeaderboard,
} from '../services/zapHistoryService';
import { isAllowanceWallet, isPrivateWallet } from '../services/walletNames';
import { getRecentMeetings, getRelevantPeople } from '../services/graphService';
import {
  CONNECT_CALENDAR_COMMAND,
  getStoredGraphToken,
} from './connectCalendarCommand';
import { createZapCard } from './sendZapCommand';
import { MAX_ZAP_SATS } from './zapBudget';
import { isRecord } from '../utils/typeGuards';

const adminKey = process.env.LNBITS_ADMINKEY as string;
const rewardLabel = process.env.LNBITS_POINTS_LABEL as string;

const toSats = (balanceMsat: number): number => Math.floor(balanceMsat / 1000);

// Shares the wallet-name rule with the leaderboard, so a casing difference
// cannot make a wallet count towards a ranking but vanish from a balance reply.
const isBalanceWallet = (wallet: Wallet): boolean =>
  isAllowanceWallet(wallet.name) || isPrivateWallet(wallet.name);

const SECONDS_PER_DAY = 86400;

const MAX_LEADERBOARD_DAYS = 365;

// The leaderboard's window is open-ended by default (all-time), unlike the
// calendar tools' rolling week, so it gets its own parameter rather than
// reusing DAYS_PARAMETER's "defaults to 7" contract.
const LEADERBOARD_DAYS_PARAMETER = {
  type: 'number',
  description:
    'Only count zaps sent in the last N days (e.g. 7 for "this week"). ' +
    `A whole number from 1 to ${MAX_LEADERBOARD_DAYS}. Omit for all-time totals.`,
};

// The model composes these arguments itself, and the runner hands them to the
// tool as parsed JSON without checking them against the schema — so the schema
// documents the contract, it does not enforce it. Every handler therefore
// takes `unknown` and narrows here.
//
// foundryAgentService already refuses a non-object before calling a handler,
// so today the fallback only fires for a direct caller of the exported
// ToolDefinition contract (the tests below are one). It stays because the
// contract is `unknown`: a handler that reads named properties off whatever
// it is handed is one refactor away from the crash this guard prevents.
const toolArgs = (args: unknown): Record<string, unknown> =>
  isRecord(args) ? args : {};

// An argument the tool does not implement is a misunderstanding, not a
// harmless extra: ignoring it answers a question nobody asked while the model
// believes its filter was applied. Naming it lets the assistant correct itself.
const unknownArgumentsError = (
  toolName: string,
  args: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined => {
  const unknown = Object.keys(args).filter(key => !allowed.includes(key));
  if (unknown.length === 0) return undefined;
  return (
    `Unknown argument(s): ${unknown.join(', ')}. ` +
    `${toolName} accepts ${allowed.length === 0 ? 'no arguments' : allowed.map(key => `"${key}"`).join(', ')} and nothing else.`
  );
};

// A truthiness test would read the string "true" as true and, worse, the
// string "false" as true as well. A flag that silently means its opposite is
// the wrong kind of quiet: get_recent_activity would return team-wide activity
// while the model believes it asked for the user's own.
const booleanArgumentError = (
  name: string,
  value: unknown,
): string | undefined =>
  value === undefined || value === null || typeof value === 'boolean'
    ? undefined
    : `"${name}" must be true or false, got ${JSON.stringify(value)}.`;

// Rejecting beats clamping here. Clamping 400 to 365 would answer a different
// question than the one asked while the reply still names the asked-for window,
// which is a wrong number stated confidently — the failure this PR exists to
// remove. An error lets the assistant ask again or say what it can do.
const leaderboardArgsError = (
  args: Record<string, unknown>,
): string | undefined => {
  const unknown = unknownArgumentsError('get_leaderboard', args, ['days']);
  if (unknown) return unknown;

  const days = args.days;
  if (days === undefined || days === null) return undefined;
  if (typeof days !== 'number' || !Number.isInteger(days)) {
    return (
      `"days" must be a whole number, got ${JSON.stringify(days)}. ` +
      `Use 1 to ${MAX_LEADERBOARD_DAYS}, or omit it for all-time totals.`
    );
  }
  if (days < 1 || days > MAX_LEADERBOARD_DAYS) {
    return (
      `"days" must be between 1 and ${MAX_LEADERBOARD_DAYS}, got ${days}. ` +
      'Omit it for all-time totals.'
    );
  }
  return undefined;
};

// Team-wide reads can miss a user or a wallet (a rate-limited LNbits response,
// say). Saying so lets the assistant hedge instead of presenting a ranking with
// someone silently missing from it as complete.
const coverageNote = (coverage: {
  partial: boolean;
  skippedUsers: number;
  skippedWallets: number;
}): string | undefined =>
  coverage.partial
    ? `Some LNbits reads failed (${coverage.skippedUsers} user(s), ` +
      `${coverage.skippedWallets} wallet(s) skipped), so these totals are a ` +
      'lower bound. Tell the user the ranking may be incomplete.'
    : undefined;

const DAYS_PARAMETER = {
  type: 'number',
  description: 'Look-back window in days. Defaults to 7, capped at 30.',
};

// Unlike the leaderboard, these tools report the window they actually
// measured back to the model (`periodDays`), so a clamped value can never be
// quoted as the asked-for one. A non-integer or non-finite value is not
// clamped, though: NaN used to survive Math.min/Math.max and reach the query,
// and a fraction reached Array.prototype.slice.
const clampWholeNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number =>
  typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, min), max)
    : fallback;

const getMyBalanceTool: ToolDefinition = {
  name: 'get_my_balance',
  description: "Get the current user's Allowance and Private wallet balances.",
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  handler: async (args: unknown, turnContext: TurnContext) => {
    const error = unknownArgumentsError('get_my_balance', toolArgs(args), []);
    if (error) return { error };

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
  parameters: {
    type: 'object',
    properties: { days: LEADERBOARD_DAYS_PARAMETER },
    required: [],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const options = toolArgs(args);
    const error = leaderboardArgsError(options);
    if (error) return { error };

    // One validated value drives both the query and the reported window, so the
    // period the assistant quotes is always the period that was measured.
    const periodDays = (options.days as number | undefined) ?? null;
    const sinceTimestamp =
      periodDays === null
        ? undefined
        : Math.floor(Date.now() / 1000) - periodDays * SECONDS_PER_DAY;
    const leaderboard = await getZapLeaderboard({ sinceTimestamp });
    return {
      rewardLabel,
      periodDays,
      partial: leaderboard.partial,
      incompleteReason: coverageNote(leaderboard),
      leaderboard: leaderboard.entries.map(entry => ({
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
    additionalProperties: false,
  },
  handler: async (args: unknown, turnContext: TurnContext) => {
    const options = toolArgs(args);
    const error =
      unknownArgumentsError('get_recent_activity', options, [
        'limit',
        'onlyInvolvingMe',
      ]) ?? booleanArgumentError('onlyInvolvingMe', options.onlyInvolvingMe);
    if (error) return { error };

    const user = turnContext.turnState.get('user') as User;
    const limit = clampWholeNumber(options.limit, 20, 1, 50);
    const activity = await getZapActivity({
      limit,
      userAadObjectId:
        options.onlyInvolvingMe === true ? user.aadObjectId : undefined,
    });
    return {
      rewardLabel,
      partial: activity.partial,
      incompleteReason: coverageNote(activity),
      activity: activity.zaps.map(entry => ({
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
    additionalProperties: false,
  },
  handler: async (args: unknown, turnContext: TurnContext) => {
    const options = toolArgs(args);
    const error = unknownArgumentsError('get_recent_meetings', options, [
      'days',
    ]);
    if (error) return { error };

    const token = await getStoredGraphToken(turnContext);
    if (!token) {
      return {
        connected: false,
        message: `Ask the user to type "${CONNECT_CALENDAR_COMMAND}" before using work signals.`,
      };
    }
    const periodDays = clampWholeNumber(options.days, 7, 1, 30);
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
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  handler: async (args: unknown, turnContext: TurnContext) => {
    const error = unknownArgumentsError(
      'get_frequent_collaborators',
      toolArgs(args),
      [],
    );
    if (error) return { error };

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

const PROPOSE_ZAP_ARGUMENTS = ['recipientName', 'amountSats', 'memo'] as const;

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
    required: [...PROPOSE_ZAP_ARGUMENTS],
    additionalProperties: false,
  },
  sideEffect: true,
  // Every refusal is shaped { proposed: false, reason } rather than the
  // { error } the read tools return: the sideEffect guard in
  // foundryAgentService only lets a proposal shape back to the model, and a
  // refusal is still a proposal outcome — it says nothing was posted and why.
  handler: async (args: unknown, turnContext: TurnContext) => {
    const options = toolArgs(args);
    const unknown = unknownArgumentsError('propose_zap', options, [
      ...PROPOSE_ZAP_ARGUMENTS,
    ]);
    if (unknown) return { proposed: false, reason: unknown };

    const sender = turnContext.turnState.get('user') as User | undefined;
    if (!sender) {
      throw new Error(
        'propose_zap: no current user in turn state, so no zap was proposed.',
      );
    }

    const { recipientName, amountSats, memo } = options;
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
    const allowance = senderWallets.find(wallet =>
      isAllowanceWallet(wallet.name),
    );
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

    if (matches.length === 0) {
      return {
        proposed: false,
        reason: `No teammate matches "${recipientName}".`,
        teammates: users.map(user => user.displayName),
      };
    }
    if (matches.length > 1) {
      return {
        proposed: false,
        reason: `"${recipientName}" matches more than one teammate — ask the user which one they mean.`,
        candidates: matches.map(user => user.displayName),
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

    // The card is the same one "send zap" posts, so its only Action.Submit is
    // the existing submitZaps gate: this tool adds no second payment path.
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
