import { TurnContext } from 'botbuilder';
import { GENERIC_ERROR_MESSAGE } from './messages';

// Catch-all for errors. Lives outside index.ts so it can be unit tested
// without starting the express server.
export const onTurnErrorHandler = async (
  context: TurnContext,
  error: Error,
) => {
  // The full error goes to the logs only: raw messages can leak internals
  // (wallet ids, env names, stack details) into the chat.
  // NOTE: In production environment, you should consider logging this to
  // Azure application insights.
  console.error(`\n [onTurnError] unhandled error: ${error}`);
  console.error(
    `User ID: ${context.activity.from?.id}, AAD Object ID: ${context.activity.from?.aadObjectId}, Display Name: ${context.activity.from?.name}`,
  );

  // Send a trace activity, which will be displayed in Bot Framework Emulator
  await context.sendTraceActivity(
    'OnTurnError Trace',
    `${error}`,
    'https://www.botframework.com/schemas/error',
    'TurnError',
  );

  // Send a single generic, friendly message to the user
  await context.sendActivity(GENERIC_ERROR_MESSAGE);
};
