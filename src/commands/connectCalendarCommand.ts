// The Azure Bot OAuth connection stores delegated Graph tokens for Teams users.

import { SSOCommand } from './SSOCommandMap';
import {
  CardFactory,
  CloudAdapter,
  MessageFactory,
  TurnContext,
} from 'botbuilder';
import { UserTokenClient } from 'botframework-connector';

export const CONNECT_CALENDAR_COMMAND = 'connect calendar';

export function requiredGraphConnectionName(): string {
  const name = process.env.GRAPH_CONNECTION_NAME;
  if (!name) throw new Error('GRAPH_CONNECTION_NAME is not set.');
  return name;
}

export function getUserTokenClient(context: TurnContext): UserTokenClient {
  const client = context.turnState.get(
    (context.adapter as CloudAdapter).UserTokenClientKey,
  );
  if (!client) {
    throw new Error('UserTokenClient is not available in turn state.');
  }
  return client;
}

export async function getStoredGraphToken(
  context: TurnContext,
  magicCode?: string,
): Promise<string | undefined> {
  const tokenResponse = await getUserTokenClient(context).getUserToken(
    context.activity.from.id,
    requiredGraphConnectionName(),
    context.activity.channelId,
    magicCode,
  );
  return tokenResponse?.token;
}

export class ConnectCalendarCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    const connectionName = requiredGraphConnectionName();
    const existing = await getStoredGraphToken(context);
    if (existing) {
      await context.sendActivity(
        'Your calendar is already connected — ask me about your recent meetings!',
      );
      return;
    }

    const resource = await getUserTokenClient(context).getSignInResource(
      connectionName,
      context.activity,
      '',
    );
    const card = CardFactory.oauthCard(
      connectionName,
      'Connect work signals',
      'Zaplie requests delegated, read-only access to calendar and relevant people so it can suggest teammates to recognise.',
      resource.signInLink,
      resource.tokenExchangeResource,
      resource.tokenPostResource,
    );
    await context.sendActivity(MessageFactory.attachment(card));
  }
}
