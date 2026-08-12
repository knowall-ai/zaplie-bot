const config = {
  botId: process.env.BOT_ID,
  botPassword: process.env.BOT_PASSWORD,
  botDomain: process.env.BOT_DOMAIN,
  authorityHost: process.env.AAD_APP_OAUTH_AUTHORITY_HOST,
  clientId: process.env.AAD_APP_CLIENT_ID,
  tenantId: process.env.AAD_APP_TENANT_ID,
  clientSecret: process.env.AAD_APP_CLIENT_SECRET,
  timeout: process.env.TIMEOUT || 30000,
};

const redact = (value?: string) => (value ? '[REDACTED]' : value);

console.log('Configuration:', {
  ...config,
  botPassword: redact(config.botPassword),
  clientSecret: redact(config.clientSecret),
});

export default config;
