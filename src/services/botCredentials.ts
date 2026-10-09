// Single start-up check for the bot's Bot Framework identity.
//
// botbuilder treats an empty MicrosoftAppId as "authentication disabled": the
// adapter then accepts activities without validating their JWT, including a
// forged one carrying an attacker-chosen serviceUrl. Real sats move through
// this bot, so a misdeployment that drops BOT_ID or BOT_PASSWORD must stop the
// process at start-up instead of quietly opening /api/messages (issue #440).

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
      'BOT_ID is not set. Without it botbuilder skips inbound JWT validation, so the bot refuses to start.',
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
