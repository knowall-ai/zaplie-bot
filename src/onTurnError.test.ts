// onTurnError.test.ts

import { onTurnErrorHandler } from './onTurnError';
import { GENERIC_ERROR_MESSAGE } from './messages';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { TurnContext } from 'botbuilder';

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
