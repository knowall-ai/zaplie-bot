// Single start-up check for the bot's Bot Framework identity.
//
// botbuilder's SingleTenant credential factory already refuses a blank app id,
// tenant or password when it is constructed, so the bot cannot start
// unauthenticated today. This check makes that requirement the application's
// own rather than a side effect of a library internal (it holds if the app
// type or botbuilder changes), gives an operator a clear error instead of a raw
// AssertionError, and also rejects a BOT_ID that is not a GUID, which
// botbuilder accepts (issue #440).

export class BotCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotCredentialsError';
  }
}

export interface BotCredentials {
  appId: string;
  appPassword: string;
  tenantId: string;
}

// An Entra application (client) id is always a GUID.
const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isBlank = (value: string | undefined): boolean => !value?.trim();

export const resolveBotCredentials = (
  environment: NodeJS.ProcessEnv = process.env,
): BotCredentials => {
  const { BOT_ID, BOT_PASSWORD, AAD_APP_TENANT_ID } = environment;

  if (isBlank(AAD_APP_TENANT_ID)) {
    throw new BotCredentialsError(
      'AAD_APP_TENANT_ID is not set. A SingleTenant bot registration cannot authenticate without it.',
    );
  }
  if (isBlank(BOT_ID)) {
    throw new BotCredentialsError(
      'BOT_ID is not set. The bot cannot authenticate to Bot Framework without its application id, so it refuses to start.',
    );
  }
  if (!GUID_PATTERN.test(BOT_ID!.trim())) {
    throw new BotCredentialsError(
      'BOT_ID is not an Entra application id (GUID), so the bot refuses to start.',
    );
  }
  if (isBlank(BOT_PASSWORD)) {
    throw new BotCredentialsError(
      'BOT_PASSWORD is not set. Without it the bot cannot authenticate to Bot Framework, so it refuses to start.',
    );
  }

  return {
    appId: BOT_ID!.trim(),
    appPassword: BOT_PASSWORD!,
    tenantId: AAD_APP_TENANT_ID!.trim(),
  };
};
