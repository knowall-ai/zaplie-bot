// foundryAgentService.test.ts
//
// Mocks the Azure SDKs (external dependencies) to pin down the tool-calling
// loop mechanic itself — the exact request/response shape (agent_reference,
// not agent; function_call_output fed back as the next input) was only
// confirmed by live trial and error against a real Foundry resource, so this
// test exists to stop it from silently regressing.
//
// projectClient/agentEnsured are cached at module scope in
// foundryAgentService.ts (intentional — ensureAgent should run once per
// process, not once per turn), so agents.update is only asserted once, and
// all tests share one mocked OpenAI client configured via mockResolvedValueOnce.

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

interface MockFoundryResponse {
  output: unknown[];
  output_text: string;
}

type MockResponseCreate = (
  request: { input: unknown; conversation: string },
  options: {
    body: { agent_reference: { name: string; type: 'agent_reference' } };
  },
) => Promise<MockFoundryResponse>;

const mockAgentsUpdate = jest
  .fn<(..._args: unknown[]) => Promise<unknown>>()
  .mockResolvedValue(undefined);
const mockConversationsCreate =
  jest.fn<(_body: Record<string, never>) => Promise<{ id: string }>>();
const mockResponsesCreate = jest.fn<MockResponseCreate>();

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

const noopTool: ToolDefinition = {
  name: 'noop_tool',
  description: 'test tool',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ ok: true }),
};

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

  test('rejects a malformed function_call response from Foundry', async () => {
    mockResponsesCreate.mockResolvedValueOnce({
      output: [
        {
          type: 'function_call',
          name: noopTool.name,
          call_id: 'call_invalid',
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
    ).rejects.toThrow(/invalid function_call payload/);
  });

  test('rejects a handler that returns undefined instead of sending a non-string output', async () => {
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
