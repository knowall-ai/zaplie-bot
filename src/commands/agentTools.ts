// agentTools.ts
//
// Read-only tools for the Foundry conversational agent. Each returns structured
// data (not a chat activity) so the agent decides how to phrase the reply.

import { TurnContext } from 'botbuilder';
import { ToolDefinition } from '../services/foundryAgentService';
import { getBalances } from '../services/peopleDirectory';
import {
  getZapActivity,
  getZapLeaderboard,
} from '../services/zapHistoryService';
import { getRecentMeetings, getRelevantPeople } from '../services/graphService';
import {
  CONNECT_CALENDAR_COMMAND,
  getStoredGraphToken,
} from './connectCalendarCommand';
import { isRecord } from '../utils/typeGuards';
import {
  MAX_LEADERBOARD_WINDOW_DAYS,
  readLeaderboardWindowDays,
  windowStartSeconds,
} from './showLeaderboardCommand';

const rewardLabel = process.env.LNBITS_POINTS_LABEL as string;

// One ceiling for the card's LEADERBOARD_WINDOW_DAYS and this tool's `days`,
// so the two accept the same range.
const MAX_LEADERBOARD_DAYS = MAX_LEADERBOARD_WINDOW_DAYS;

// When `days` is omitted the tool measures the same window as the
// `show leaderboard` card (LEADERBOARD_WINDOW_DAYS), so the assistant and the
// card quote the same numbers for "who is top?". It gets its own parameter
// rather than reusing DAYS_PARAMETER, whose default and cap belong to the
// calendar tools.
const LEADERBOARD_DAYS_PARAMETER = {
  type: 'number',
  description:
    'Only count zaps sent in the last N days (e.g. 7 for "this week"). ' +
    `A whole number from 1 to ${MAX_LEADERBOARD_DAYS}. Omit to use the same ` +
    'window as the team leaderboard card; the reply says which window that is ' +
    '(periodDays).',
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
      `Use 1 to ${MAX_LEADERBOARD_DAYS}, or omit it for the leaderboard card's window.`
    );
  }
  if (days < 1 || days > MAX_LEADERBOARD_DAYS) {
    return (
      `"days" must be between 1 and ${MAX_LEADERBOARD_DAYS}, got ${days}. ` +
      "Omit it for the leaderboard card's window."
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
  description:
    "Get the current user's Allowance balance (and remaining budget when the wallet reports it). The Private wallet is the user's own and is not readable.",
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
    const balances = await getBalances(user.id);
    // A wallet Zaplie cannot read is reported as unknown, never as 0: the
    // Private wallet is the person's own and Zaplie never reads it.
    return {
      rewardLabel,
      wallets: [
        {
          name: 'Allowance',
          balanceSats:
            balances.allowanceSats === null
              ? null
              : Math.floor(balances.allowanceSats),
          ...(balances.budgetRemainingSats !== null
            ? { budgetRemainingSats: balances.budgetRemainingSats }
            : {}),
        },
        {
          name: 'Private',
          balanceSats: null,
          note: "the person's own wallet; Zaplie does not read it",
        },
      ],
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

    // Without `days`, use the card's configured window. A bad setting fails
    // closed here too: an error the assistant can relay, and a log line naming
    // the variable, rather than an all-time ranking nobody asked for.
    let periodDays: number;
    if (typeof options.days === 'number') {
      periodDays = options.days;
    } else {
      try {
        periodDays = readLeaderboardWindowDays();
      } catch (settingError) {
        console.error(
          'get_leaderboard: invalid leaderboard setting:',
          settingError,
        );
        return {
          error:
            'The leaderboard is not available right now because its configured ' +
            'window is invalid. Ask an administrator to check the bot settings.',
        };
      }
    }

    // One validated value drives both the query and the reported window, so the
    // period the assistant quotes is always the period that was measured.
    const leaderboard = await getZapLeaderboard({
      sinceTimestamp: windowStartSeconds(periodDays),
    });
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
