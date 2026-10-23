// The Azure Bot OAuth connection stores delegated Graph tokens for Teams users.

import { SSOCommand } from './SSOCommandMap';
import {
  CardFactory,
  CloudAdapter,
  MessageFactory,
  TurnContext,
} from 'botbuilder';
import { UserTokenClient } from 'botframework-connector';
import { t } from '../i18n';

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
    const locale = context.activity?.locale;
    const existing = await getStoredGraphToken(context);
    if (existing) {
      await context.sendActivity(t(locale, 'calendarAlreadyConnected'));
      return;
    }

    const resource = await getUserTokenClient(context).getSignInResource(
      connectionName,
      context.activity,
      '',
    );
    const card = CardFactory.oauthCard(
      connectionName,
      t(locale, 'calendarCardTitle'),
      t(locale, 'calendarCardText'),
      resource.signInLink,
      resource.tokenExchangeResource,
      resource.tokenPostResource,
    );
    await context.sendActivity(MessageFactory.attachment(card));
  }
}
