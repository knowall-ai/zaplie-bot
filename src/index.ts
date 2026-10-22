// Import required packages
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';

// Import required bot services.
// See https://aka.ms/bot-services to learn more about the different parts of a bot.
import {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  ConfigurationBotFrameworkAuthentication,
  MemoryStorage,
  TeamsSSOTokenExchangeMiddleware,
} from 'botbuilder';

// This bot's main dialog.
import { TeamsBot } from './teamsBot';
import { onTurnErrorHandler } from './onTurnError';
// Imported for its side effect: it logs the (redacted) configuration at start-up.
import './config';
import { resolveBotCredentials } from './services/botCredentials';
import { UserService } from './services/userService';
import { FetchUserMiddleware } from './services/fetchUserMiddleware';
import { RewardLedger } from './services/rewardLedger';
import { createRewardsRouter } from './rewardsRoute';

// Create adapter.
// See https://aka.ms/about-bot-adapter to learn more about adapters.
// The SingleTenant factory below already rejects blank credentials; the
// resolver states that requirement explicitly, with clear errors, and also
// rejects a BOT_ID that is not a GUID (#440).
const botCredentials = resolveBotCredentials();

const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: botCredentials.appId,
  MicrosoftAppPassword: botCredentials.appPassword,
  MicrosoftAppType: 'SingleTenant',
  MicrosoftAppTenantId: botCredentials.tenantId,
});

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(
  {},
  credentialsFactory,
);

const adapter = new CloudAdapter(botFrameworkAuthentication);

// Add EnsureUserSetupMiddleware to the adapter's middleware pipeline
// Create UserService instance (using the singleton pattern)
const userService = UserService.getInstance();

if (process.env.GRAPH_CONNECTION_NAME) {
  adapter.use(
    new TeamsSSOTokenExchangeMiddleware(
      new MemoryStorage(),
      process.env.GRAPH_CONNECTION_NAME,
    ),
  );
}

// Add FetchUserMiddleware and pass the userService instance
adapter.use(new FetchUserMiddleware(userService));

// Set the onTurnError for the singleton CloudAdapter
adapter.onTurnError = onTurnErrorHandler;

// Create the bot that will handle incoming messages.
const bot = new TeamsBot();

// Constructed at start-up, like the zap ledger inside TeamsBot: a missing
// ZAPLIE_DATA_DIR or an unreadable store stops the bot here instead of
// failing the first reward payment.
const rewardLedger = new RewardLedger();

// Create HTTP server. Express instead of restify: restify still requires
// spdy, whose native http_parser binding no longer exists on Node >= 21.
const server = express();
server.disable('x-powered-by');
server.use(express.json());
server.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
const port = Number(process.env.port || process.env.PORT || 3978);
server.listen(port, () => {
  console.log(`\nBot Started, express listening on port ${port}`);
});

// Listen for incoming requests.
server.post('/api/messages', async (req, res) => {
  await adapter
    .process(req, res, async context => {
      await bot.run(context);
    })
    .catch(err => {
      // Error message including "412" means it is waiting for user's consent, which is a normal process of SSO, sholdn't throw this error.
      if (!err.message.includes('412')) {
        throw err;
      }
    });
});

server.use(createRewardsRouter({ ledger: rewardLedger }));

const authStartPage = fs.readFileSync(
  path.join(__dirname, '../public/auth-start.html'),
  'utf8',
);
const authEndPage = fs.readFileSync(
  path.join(__dirname, '../public/auth-end.html'),
  'utf8',
);

server.get('/auth-start.html', (_req, res) => {
  res.type('html').send(authStartPage);
});
server.get('/auth-end.html', (_req, res) => {
  res.type('html').send(authEndPage);
});
