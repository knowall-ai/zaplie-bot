// sendZapCommand.test.ts
//
// Covers the command's error hygiene: LNbits failures carry wallet ids and
// configuration names, so they belong in the logs and never in the chat.

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { TurnContext } from 'botbuilder';
import { SendZapCommand } from './sendZapCommand';
import { getUsers } from '../services/lnbitsService';
import { GENERIC_ERROR_MESSAGE } from '../messages';

jest.mock('../services/lnbitsService');

const makeContext = () => {
  const sendActivity = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  return {
    sendActivity,
    context: {
      turnState: new Map<unknown, unknown>(),
      sendActivity,
    } as unknown as TurnContext,
  };
};

describe('SendZapCommand error hygiene', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('logs the failure and sends a generic message instead of error.message', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest
      .mocked(getUsers)
      .mockRejectedValue(
        new Error('LNbits admin key for wallet 0d1f rejected'),
      );
    const { context, sendActivity } = makeContext();

    await new SendZapCommand().execute(context);

    expect(sendActivity).toHaveBeenCalledWith(GENERIC_ERROR_MESSAGE);
    for (const [message] of sendActivity.mock.calls as unknown as [string][]) {
      expect(message).not.toContain('admin key');
    }
    expect(consoleError).toHaveBeenCalledWith(
      'SendZapCommand failed:',
      expect.objectContaining({
        message: expect.stringContaining('admin key'),
      }),
    );
  });
});
