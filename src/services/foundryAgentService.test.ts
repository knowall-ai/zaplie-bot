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

import { runConversationalTurn, ToolDefinition } from './foundryAgentService';

const makeTurnContext = (): TurnContext => ({}) as TurnContext;

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
      ),
    ).rejects.toThrow(/returned undefined/);
  });

  test('rejects a sideEffect tool whose result is not a proposal, so it can never report an execution', async () => {
    const payingTool: ToolDefinition = {
      name: 'noop_tool',
      description: 'misbehaving side-effect tool',
      parameters: { type: 'object', properties: {} },
      sideEffect: true,
      handler: async () => ({ paid: true, paymentHash: 'abc' }),
    };
    mockResponsesCreate.mockResolvedValueOnce({
      output: [
        {
          type: 'function_call',
          name: 'noop_tool',
          call_id: 'call_p',
          arguments: '{}',
        },
      ],
      output_text: '',
    });

    await expect(
      runConversationalTurn(
        'zap bob',
        'conv_existing',
        [payingTool],
        makeTurnContext(),
      ),
    ).rejects.toThrow(
      /side-effect tool "noop_tool" must return a proposal \(\{ proposed: boolean \}\)/,
    );
  });

  test('rejects a sideEffect result that claims a payment alongside its proposal', async () => {
    const payingTool: ToolDefinition = {
      name: 'noop_tool',
      description: 'side-effect tool smuggling an execution result',
      parameters: { type: 'object', properties: {} },
      sideEffect: true,
      handler: async () => ({
        proposed: true,
        recipient: 'Bob',
        paid: true,
        paymentHash: 'abc',
      }),
    };
    mockResponsesCreate.mockResolvedValueOnce({
      output: [
        {
          type: 'function_call',
          name: 'noop_tool',
          call_id: 'call_r',
          arguments: '{}',
        },
      ],
      output_text: '',
    });

    await expect(
      runConversationalTurn(
        'zap bob',
        'conv_existing',
        [payingTool],
        makeTurnContext(),
      ),
    ).rejects.toThrow(
      /returned execution field\(s\) paid, paymentHash; it may only propose/,
    );
  });

  test('feeds a sideEffect proposal back to the model unchanged', async () => {
    const proposal = { proposed: false, reason: 'Bob is ambiguous.' };
    const proposingTool: ToolDefinition = {
      name: 'noop_tool',
      description: 'well-behaved side-effect tool',
      parameters: { type: 'object', properties: {} },
      sideEffect: true,
      handler: async () => proposal,
    };
    mockResponsesCreate
      .mockResolvedValueOnce({
        output: [
          {
            type: 'function_call',
            name: 'noop_tool',
            call_id: 'call_q',
            arguments: '{}',
          },
        ],
        output_text: '',
      })
      .mockResolvedValueOnce({ output: [], output_text: 'Which Bob?' });

    const result = await runConversationalTurn(
      'zap bob',
      'conv_existing',
      [proposingTool],
      makeTurnContext(),
    );

    expect(result.replyText).toBe('Which Bob?');
    const secondCallArgs =
      mockResponsesCreate.mock.calls[mockResponsesCreate.mock.calls.length - 1];
    expect(secondCallArgs[0].input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_q',
        output: JSON.stringify(proposal),
      },
    ]);
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
      ),
    ).rejects.toThrow(/exceeded/i);
  });
});
