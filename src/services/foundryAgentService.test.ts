// foundryAgentService.test.ts
//
// Mocks the Azure SDKs (external dependencies) to pin down the tool-calling
// loop mechanic itself — the exact request/response shape (agent_reference,
// not agent; function_call_output fed back as the next input) was only
// confirmed by live trial and error against a real Foundry resource, so this
// test exists to stop it from silently regressing.
//
// projectClient/agentEnsured are cached at module scope in
// foundryAgentService.ts (intentional — ensureAgent re-runs only when the
// composed instructions change, not once per turn), so agents.update is
// asserted sparingly, and all tests share one mocked OpenAI client configured
// via mockResolvedValueOnce.

import { expect, describe, test, beforeAll, jest } from '@jest/globals';
import { TurnContext } from 'botbuilder';

jest.mock('@azure/identity', () => ({
  DefaultAzureCredential: jest.fn(),
}));

jest.mock('../config', () => ({
  __esModule: true,
  default: {
    foundryProjectEndpoint:
      'https://test-resource.services.ai.azure.com/api/projects/test-project',
    foundryModel: 'test-model',
  },
}));

interface MockAgentDefinition {
  kind: string;
  model: string;
  instructions: string;
  tools: unknown[];
}

interface MockFoundryResponse {
  output: unknown[];
  output_text: string;
}

type MockResponsesCreate = (
  request: { input: unknown; conversation: string },
  options: {
    body: { agent_reference: { name: string; type: 'agent_reference' } };
  },
) => Promise<MockFoundryResponse>;

const mockAgentsUpdate = jest
  .fn<(name: string, definition: MockAgentDefinition) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockGetBotPersona = jest
  .fn<() => Promise<string>>()
  .mockResolvedValue('');

jest.mock('./fetchBotPersona', () => ({
  getBotPersona: mockGetBotPersona,
}));

const mockConversationsCreate = jest.fn<() => Promise<{ id: string }>>();
const mockResponsesCreate = jest.fn<MockResponsesCreate>();

jest.mock('@azure/ai-projects', () => ({
  AIProjectClient: jest.fn().mockImplementation(() => ({
    agents: { update: mockAgentsUpdate },
    // getOpenAIClient is synchronous in the real SDK — no .mockResolvedValue.
    getOpenAIClient: jest.fn().mockReturnValue({
      conversations: { create: mockConversationsCreate },
      responses: { create: mockResponsesCreate },
    }),
  })),
}));

import {
  ENGLISH_REPLY_HINT,
  howZaplieWorks,
  runConversationalTurn,
  SPANISH_REPLY_HINT,
  ToolDefinition,
} from './foundryAgentService';

const makeTurnContext = (): TurnContext => ({}) as TurnContext;

// Most turns don't exercise the command list; an empty one omits the section.
const NO_COMMANDS: string[] = [];

// The handler contract is `unknown`, so a test tool narrows its own arguments
// exactly as a real one does.
const readTextArgument = (args: unknown): string => {
  if (
    typeof args !== 'object' ||
    args === null ||
    !('text' in args) ||
    typeof args.text !== 'string'
  ) {
    throw new Error('Expected a string text argument.');
  }
  return args.text;
};

const noopTool: ToolDefinition = {
  name: 'noop_tool',
  description: 'test tool',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ ok: true }),
};

describe('foundryAgentService.runConversationalTurn', () => {
  beforeAll(() => {
    mockConversationsCreate.mockResolvedValue({ id: 'conv_new' });
  });

  test('returns output_text directly when the model needs no tools', async () => {
    mockResponsesCreate.mockResolvedValueOnce({
      output: [],
      output_text: 'Hi there!',
    });

    const result = await runConversationalTurn(
      'hello',
      undefined,
      [noopTool],
      makeTurnContext(),
      NO_COMMANDS,
    );

    expect(result.replyText).toBe('Hi there!');
    expect(result.foundryConversationId).toBe('conv_new');
    expect(mockAgentsUpdate).toHaveBeenCalledWith(
      'zaplie-assistant',
      expect.objectContaining({
        kind: 'prompt',
        model: 'test-model',
        instructions: expect.stringMatching(
          /recent meetings[\s\S]*frequent collaborators[\s\S]*recent zap activity/,
        ),
        tools: [
          expect.objectContaining({ type: 'function', name: 'noop_tool' }),
        ],
      }),
    );
  });

  test('reuses an existing conversation id instead of creating a new one', async () => {
    mockConversationsCreate.mockClear();
    mockResponsesCreate.mockResolvedValueOnce({
      output: [],
      output_text: 'ok',
    });

    const result = await runConversationalTurn(
      'hello again',
      'conv_existing',
      [noopTool],
      makeTurnContext(),
      NO_COMMANDS,
    );

    expect(result.foundryConversationId).toBe('conv_existing');
    expect(mockConversationsCreate).not.toHaveBeenCalled();
  });

  test('dispatches a function_call, feeds function_call_output back, and returns the final answer', async () => {
    const echoTool: ToolDefinition = {
      name: 'echo',
      description: 'echoes the input',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      handler: async args => ({ echoed: readTextArgument(args) }),
    };

    mockResponsesCreate
      .mockResolvedValueOnce({
        output: [
          {
            type: 'function_call',
            name: 'echo',
            call_id: 'call_1',
            arguments: JSON.stringify({ text: 'hi' }),
          },
        ],
        output_text: '',
      })
      .mockResolvedValueOnce({ output: [], output_text: 'You said hi' });

    const result = await runConversationalTurn(
      'please echo hi',
      'conv_existing',
      [echoTool],
      makeTurnContext(),
      NO_COMMANDS,
    );

    expect(result.replyText).toBe('You said hi');
    // Second call must feed back a function_call_output referencing the same call_id.
    const secondCallArgs =
      mockResponsesCreate.mock.calls[mockResponsesCreate.mock.calls.length - 1];
    expect(secondCallArgs[0].input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: JSON.stringify({ echoed: 'hi' }),
      },
    ]);
    // Body must use agent_reference, not the deprecated `agent` field.
    expect(secondCallArgs[1].body.agent_reference).toEqual({
      name: 'zaplie-assistant',
      type: 'agent_reference',
    });
  });

  test('composes the admin persona inside the fixed guardrails, and re-upserts only when it changes', async () => {
    mockGetBotPersona.mockResolvedValue('Be upbeat and celebrate specifics.');
    mockAgentsUpdate.mockClear();
    mockResponsesCreate.mockResolvedValueOnce({
      output: [],
      output_text: 'ok',
    });

    await runConversationalTurn(
      'hi',
      'conv_existing',
      [noopTool],
      makeTurnContext(),
      NO_COMMANDS,
    );

    expect(mockAgentsUpdate).toHaveBeenCalledTimes(1);
    const { instructions } = mockAgentsUpdate.mock.calls[0][1];
    // The rails come first and are restated last; the persona is fenced in
    // between and framed as configuration, not as instructions.
    expect(instructions).toMatch(
      /Never invent numbers[\s\S]*untrusted data[\s\S]*BEGIN PERSONA ---\nBe upbeat and celebrate specifics\.\n--- END PERSONA ---[\s\S]*always take precedence/,
    );

    // The same persona again must not re-upsert the agent.
    mockAgentsUpdate.mockClear();
    mockResponsesCreate.mockResolvedValueOnce({
      output: [],
      output_text: 'ok',
    });
    await runConversationalTurn(
      'hi',
      'conv_existing',
      [noopTool],
      makeTurnContext(),
      NO_COMMANDS,
    );
    expect(mockAgentsUpdate).not.toHaveBeenCalled();

    // A changed persona re-upserts, so an admin's save lands without a restart.
    mockGetBotPersona.mockResolvedValue('Be terse and formal.');
    mockResponsesCreate.mockResolvedValueOnce({
      output: [],
      output_text: 'ok',
    });
    await runConversationalTurn(
      'hi',
      'conv_existing',
      [noopTool],
      makeTurnContext(),
      NO_COMMANDS,
    );
    expect(mockAgentsUpdate).toHaveBeenCalledTimes(1);
    expect(mockAgentsUpdate.mock.calls[0][1].instructions).toContain(
      'Be terse and formal.',
    );
  });

  test('falls back to the built-in voice when no persona is set', async () => {
    mockGetBotPersona.mockResolvedValue('');
    mockAgentsUpdate.mockClear();
    mockResponsesCreate.mockResolvedValueOnce({
      output: [],
      output_text: 'ok',
    });

    await runConversationalTurn(
      'hi',
      'conv_existing',
      [noopTool],
      makeTurnContext(),
      NO_COMMANDS,
    );

    const { instructions } = mockAgentsUpdate.mock.calls[0][1];
    expect(instructions).toContain(
      'Keep replies concise and friendly, suited for a Teams chat.',
    );
    expect(instructions).toContain('Never invent numbers');
    // "Withdraw my zaps" is unlisted and still a stub, but free text about
    // withdrawing reaches the agent — so the rails say so rather than letting
    // it improvise a payout route.
    expect(instructions).toContain('withdrawals are not available yet');
    // It speaks as Zaplie itself, not as a helper beside the tool.
    expect(instructions).toMatch(/^You are Zaplie, a bot in Microsoft Teams\./);
    expect(instructions).not.toContain("Zaplie's assistant");
    // A stated scope, so the model doesn't answer one Bitcoin question and
    // refuse the next: general Bitcoin/Lightning questions yes, advice no.
    expect(instructions).toContain('what is a Lightning channel?');
    expect(instructions).toContain(
      'Do not give investment, price, trading or tax advice',
    );
    expect(instructions).toContain('Politely decline questions unrelated');
  });

  test('tells the agent the real commands and that zapping is "send zap"', async () => {
    mockGetBotPersona.mockResolvedValue('');
    mockAgentsUpdate.mockClear();
    mockResponsesCreate.mockResolvedValueOnce({
      output: [],
      output_text: 'ok',
    });

    await runConversationalTurn(
      'how do I send a zap?',
      'conv_existing',
      [noopTool],
      makeTurnContext(),
      ['send zap', 'show my balance', 'show leaderboard'],
    );

    // A new command list changes the composed instructions, so the agent is
    // updated rather than left with the old ones.
    expect(mockAgentsUpdate).toHaveBeenCalledTimes(1);
    const { instructions } = mockAgentsUpdate.mock.calls[0][1];
    expect(instructions).toContain('- "send zap"');
    expect(instructions).toContain('- "show my balance"');
    expect(instructions).toContain('- "show leaderboard"');
    expect(instructions).toContain('tell them to type "send zap"');
    expect(instructions).toContain('never invent buttons, menus, tabs, apps');
    // The persona still comes last, so the fixed rules wrap it.
    expect(instructions.indexOf('- "send zap"')).toBeLessThan(
      instructions.indexOf('--- BEGIN PERSONA ---'),
    );
  });

  test('names the unregistered tool and the registered ones when the agent drifts', async () => {
    mockResponsesCreate.mockResolvedValueOnce({
      output: [
        {
          type: 'function_call',
          name: 'not_a_real_tool',
          call_id: 'call_x',
          arguments: '{}',
        },
      ],
      output_text: '',
    });

    await expect(
      runConversationalTurn(
        'do something',
        'conv_existing',
        [noopTool],
        makeTurnContext(),
        NO_COMMANDS,
      ),
    ).rejects.toThrow(
      /unregistered tool "not_a_real_tool"[\s\S]*Registered tools: /,
    );
  });

  test('names the tool and the payload when its arguments are not valid JSON', async () => {
    mockResponsesCreate.mockResolvedValueOnce({
      output: [
        {
          type: 'function_call',
          name: noopTool.name,
          call_id: 'call_y',
          arguments: '{not json',
        },
      ],
      output_text: '',
    });

    await expect(
      runConversationalTurn(
        'do something',
        'conv_existing',
        [noopTool],
        makeTurnContext(),
        NO_COMMANDS,
      ),
    ).rejects.toThrow(
      /could not parse the arguments for tool "noop_tool"[\s\S]*\{not json/,
    );
  });

  // A model sending "null" or "[]" for a no-argument tool is a mistake it can
  // fix on the next round. Killing the turn over it would also clear the
  // conversation id, so the fix is to hand the mistake back as tool output.
  test.each([
    ['null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"bob"'],
  ])(
    'hands %s arguments back as a tool error instead of ending the turn',
    async (_label, argumentsJson) => {
      const handler = jest.fn<ToolDefinition['handler']>();
      mockResponsesCreate
        .mockResolvedValueOnce({
          output: [
            {
              type: 'function_call',
              name: noopTool.name,
              call_id: 'call_not_an_object',
              arguments: argumentsJson,
            },
          ],
          output_text: '',
        })
        .mockResolvedValueOnce({ output: [], output_text: 'Let me retry.' });

      const result = await runConversationalTurn(
        'do something',
        'conv_existing',
        [{ ...noopTool, handler }],
        makeTurnContext(),
        NO_COMMANDS,
      );

      expect(result.replyText).toBe('Let me retry.');
      // The handler never sees a non-object, which is what the guard is for.
      expect(handler).not.toHaveBeenCalled();

      const fedBack =
        mockResponsesCreate.mock.calls[
          mockResponsesCreate.mock.calls.length - 1
        ][0].input;
      expect(fedBack).toEqual([
        {
          type: 'function_call_output',
          call_id: 'call_not_an_object',
          output: expect.stringContaining('must be a JSON object'),
        },
      ]);
    },
  );

  test('rejects a malformed function_call item from Foundry', async () => {
    mockResponsesCreate.mockResolvedValueOnce({
      output: [
        { type: 'function_call', name: noopTool.name, call_id: 'call_invalid' },
      ],
      output_text: '',
    });

    await expect(
      runConversationalTurn(
        'do something',
        'conv_existing',
        [noopTool],
        makeTurnContext(),
        NO_COMMANDS,
      ),
    ).rejects.toThrow(/invalid function_call payload/);
  });

  test('rejects a top-level response payload that is missing output or output_text', async () => {
    mockResponsesCreate.mockResolvedValueOnce({
      output: 'not-an-array',
      output_text: 'hi',
    } as unknown as MockFoundryResponse);

    await expect(
      runConversationalTurn(
        'do something',
        'conv_existing',
        [noopTool],
        makeTurnContext(),
        NO_COMMANDS,
      ),
    ).rejects.toThrow(
      'foundryAgentService: Foundry returned an invalid response payload.',
    );
  });

  test('ignores non-function-call items in the output array instead of rejecting them', async () => {
    mockResponsesCreate.mockResolvedValueOnce({
      output: [{ type: 'message', content: 'thinking out loud' }],
      output_text: 'All done, no tools needed.',
    });

    const result = await runConversationalTurn(
      'hello',
      'conv_existing',
      [noopTool],
      makeTurnContext(),
      NO_COMMANDS,
    );

    expect(result.replyText).toBe('All done, no tools needed.');
  });

  test('rejects a handler that returns undefined, which cannot be sent as function_call_output', async () => {
    const undefinedTool: ToolDefinition = {
      ...noopTool,
      handler: async () => undefined,
    };
    mockResponsesCreate.mockResolvedValueOnce({
      output: [
        {
          type: 'function_call',
          name: noopTool.name,
          call_id: 'call_z',
          arguments: '{}',
        },
      ],
      output_text: '',
    });

    await expect(
      runConversationalTurn(
        'do something',
        'conv_existing',
        [undefinedTool],
        makeTurnContext(),
        NO_COMMANDS,
      ),
    ).rejects.toThrow(/returned undefined/);
  });

  test('throws instead of looping forever if the model never stops calling tools', async () => {
    mockResponsesCreate.mockReset();
    mockResponsesCreate.mockResolvedValue({
      output: [
        {
          type: 'function_call',
          name: 'noop_tool',
          call_id: 'call_loop',
          arguments: '{}',
        },
      ],
      output_text: '',
    });

    await expect(
      runConversationalTurn(
        'loop forever',
        'conv_existing',
        [noopTool],
        makeTurnContext(),
        NO_COMMANDS,
      ),
    ).rejects.toThrow(/exceeded/i);
  });
});

describe('howZaplieWorks', () => {
  test('lists exactly the commands it is given', () => {
    const text = howZaplieWorks(['send zap', 'connect calendar']);
    expect(text).toContain('- "send zap"\n- "connect calendar"');
    expect(text).not.toContain('show leaderboard');
  });

  test('says how to zap only when "send zap" is registered', () => {
    expect(howZaplieWorks(['show leaderboard'])).not.toContain('card opens');
    expect(howZaplieWorks(['send zap'])).toContain('type "send zap"');
  });

  test('is empty when there are no commands', () => {
    expect(howZaplieWorks([])).toBe('');
  });
});

// Ben's pre-merge point 3: a Spanish client's free-text question must be
// answered in Spanish. The hint rides on the turn's own input, never in the
// agent instructions: ensureAgent caches the agent by a hash of those, so a
// language in them would re-create the agent on every en/es switch. Every turn
// carries a hint in both directions, because the items are stored in the
// Foundry conversation and an English turn has to override a Spanish one.
describe('foundryAgentService.runConversationalTurn language', () => {
  const contextWithLocale = (locale: unknown): TurnContext =>
    ({ activity: { locale } }) as unknown as TurnContext;

  const firstInput = (): unknown =>
    mockResponsesCreate.mock.calls[mockResponsesCreate.mock.calls.length - 1][0]
      .input;

  beforeAll(() => {
    mockConversationsCreate.mockResolvedValue({ id: 'conv_new' });
  });

  test('tells the assistant to answer an es-MX client in Spanish, on the turn itself', async () => {
    mockResponsesCreate.mockResolvedValueOnce({
      output: [],
      output_text: '¡Hola!',
    });

    await runConversationalTurn(
      '¿qué puedo hacer?',
      'conv_existing',
      [noopTool],
      contextWithLocale('es-MX'),
      NO_COMMANDS,
    );

    expect(firstInput()).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: expect.stringMatching(/Reply in Spanish/),
      },
      { type: 'message', role: 'user', content: '¿qué puedo hacer?' },
    ]);
  });

  test('tells the assistant a non-Spanish client gets the language it wrote in', async () => {
    for (const locale of ['en-US', 'fr-FR', undefined, 'es-@@']) {
      mockResponsesCreate.mockResolvedValueOnce({
        output: [],
        output_text: 'ok',
      });

      await runConversationalTurn(
        'hello',
        'conv_existing',
        [noopTool],
        contextWithLocale(locale),
        NO_COMMANDS,
      );

      // The user's text is the second item, unchanged.
      expect({ locale, input: firstInput() }).toEqual({
        locale,
        input: [
          { type: 'message', role: 'developer', content: ENGLISH_REPLY_HINT },
          { type: 'message', role: 'user', content: 'hello' },
        ],
      });
    }
  });

  // https://github.com/knowall-ai/zaplie-bot/issues/516: the developer item is
  // stored in the Foundry conversation and replayed on later turns, so an
  // English turn must override the stored Spanish hint, not go out bare.
  test('an English turn after a Spanish one in the same conversation carries an explicit English counter-hint', async () => {
    mockConversationsCreate.mockClear();
    mockAgentsUpdate.mockClear();
    mockResponsesCreate
      .mockResolvedValueOnce({ output: [], output_text: '¡Hola!' })
      .mockResolvedValueOnce({ output: [], output_text: 'Hello!' });

    await runConversationalTurn(
      'hola',
      'conv_shared',
      [noopTool],
      contextWithLocale('es-MX'),
      NO_COMMANDS,
    );
    await runConversationalTurn(
      'hello',
      'conv_shared',
      [noopTool],
      contextWithLocale('en-US'),
      NO_COMMANDS,
    );

    const calls = mockResponsesCreate.mock.calls.slice(-2);
    // Both turns went to the same Foundry conversation, which is where the
    // Spanish item now lives.
    expect(calls.map(call => call[0].conversation)).toEqual([
      'conv_shared',
      'conv_shared',
    ]);
    expect(mockConversationsCreate).not.toHaveBeenCalled();
    expect(calls[0][0].input).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: expect.stringMatching(/Reply in Spanish/),
      },
      { type: 'message', role: 'user', content: 'hola' },
    ]);
    // The English turn does not go out bare: it overrides the stored hint.
    expect(calls[1][0].input).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: expect.stringMatching(
          /not set to Spanish[\s\S]*no longer applies/,
        ),
      },
      { type: 'message', role: 'user', content: 'hello' },
    ]);
    expect((calls[1][0].input as { content: string }[])[0].content).not.toMatch(
      /Reply in Spanish/,
    );
    // A language switch never touches the agent.
    expect(mockAgentsUpdate).not.toHaveBeenCalled();
  });

  test('switching language never re-creates the agent', async () => {
    mockGetBotPersona.mockResolvedValue('');
    mockResponsesCreate.mockResolvedValue({ output: [], output_text: 'ok' });
    // Settle the agent for this persona first.
    await runConversationalTurn(
      'hello',
      'conv_existing',
      [noopTool],
      contextWithLocale('en-US'),
      NO_COMMANDS,
    );
    mockAgentsUpdate.mockClear();

    for (const locale of ['es-MX', 'en-US', 'es-ES']) {
      await runConversationalTurn(
        'hola',
        'conv_existing',
        [noopTool],
        contextWithLocale(locale),
        NO_COMMANDS,
      );
    }

    expect(mockAgentsUpdate).not.toHaveBeenCalled();
    mockResponsesCreate.mockReset();
  });
});

describe('reply-language hints', () => {
  test.each([
    ['Spanish', SPANISH_REPLY_HINT],
    ['English', ENGLISH_REPLY_HINT],
  ])(
    'the %s hint keeps names, amounts and the reward label unchanged',
    (_language, hint) => {
      expect(hint).toMatch(
        /keep wallet names, display names, amounts and the reward label unchanged/,
      );
    },
  );
});
