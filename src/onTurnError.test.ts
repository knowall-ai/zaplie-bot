// onTurnError.test.ts

import { onTurnErrorHandler } from './onTurnError';
import { GENERIC_ERROR_MESSAGE } from './messages';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { TurnContext } from 'botbuilder';
import { pulseSettled, resetPulseForTests } from './services/pulse';

// agent-pulse: a stand-in library, loaded through the wrapper's test hook
// (jest cannot run the real ES import), so the events can be asserted.
const mockPulseEmit = jest.fn();
const usePulseStandIn = (): void => {
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = 'InstrumentationKey=test';
  resetPulseForTests(async () => ({
    createPulse: () => ({
      emit: async (event: unknown) => {
        mockPulseEmit(event);
      },
      flush: async () => undefined,
    }),
    activityIdFrom: (id: string) => `sha256:${id}`,
  }));
};
const dropPulseStandIn = (): void => {
  delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  resetPulseForTests();
};

const makeContext = () => {
  const sendActivity = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const sendTraceActivity = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const context = {
    activity: {
      from: { id: 'user-1', aadObjectId: 'aad-1', name: 'Alice' },
    },
    sendActivity,
    sendTraceActivity,
  } as unknown as TurnContext;
  return { context, sendActivity, sendTraceActivity };
};

describe('onTurnErrorHandler', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('sends a single generic message instead of the raw error', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { context, sendActivity } = makeContext();
    const error = new Error('wallet inkey abc123 leaked');

    await onTurnErrorHandler(context, error);

    expect(sendActivity).toHaveBeenCalledTimes(1);
    expect(sendActivity).toHaveBeenCalledWith(GENERIC_ERROR_MESSAGE);
    for (const [message] of sendActivity.mock.calls as unknown as [string][]) {
      expect(message).not.toContain('wallet inkey abc123 leaked');
      expect(message).not.toContain('fix the bot source code');
    }
    // The error object, not its interpolation: the stack must reach the logs.
    expect(consoleError).toHaveBeenCalledWith(
      '\n [onTurnError] unhandled error:',
      error,
    );
  });

  test('still emits the Bot Framework Emulator trace activity', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { context, sendTraceActivity } = makeContext();

    await onTurnErrorHandler(context, new Error('boom'));

    expect(sendTraceActivity).toHaveBeenCalledWith(
      'OnTurnError Trace',
      expect.stringContaining('boom'),
      'https://www.botframework.com/schemas/error',
      'TurnError',
    );
  });
});

describe('onTurnErrorHandler on a proactive turn', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('stays silent when the turn has no sender', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { context, sendActivity, sendTraceActivity } = makeContext();
    (context as unknown as { activity: { from?: unknown } }).activity.from =
      undefined;
    const error = new Error('createConversation pipeline failure');

    await onTurnErrorHandler(context, error);

    expect(sendActivity).not.toHaveBeenCalled();
    expect(sendTraceActivity).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '\n [onTurnError] unhandled error:',
      error,
    );
  });
});

describe('onTurnErrorHandler telemetry', () => {
  beforeEach(usePulseStandIn);

  afterEach(() => {
    dropPulseStandIn();
    mockPulseEmit.mockReset();
    jest.restoreAllMocks();
  });

  test('records chat.failed and still apologises when telemetry throws', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { context, sendActivity } = makeContext();

    await onTurnErrorHandler(context, new Error('boom'));
    await pulseSettled();
    expect(mockPulseEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        activityType: 'chat.failed',
        level: 'error',
        subject: 'turn-error',
      }),
    );

    mockPulseEmit.mockImplementation(() => {
      throw new Error('telemetry down');
    });
    await onTurnErrorHandler(context, new Error('boom'));
    await pulseSettled();
    expect(sendActivity).toHaveBeenCalledTimes(2);
    expect(sendActivity).toHaveBeenLastCalledWith(GENERIC_ERROR_MESSAGE);
  });
});
