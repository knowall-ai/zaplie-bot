// Import required packages
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, timingSafeEqual } from 'crypto';
import { getWebhookKeyHashes } from './services/fetchWebhookKeys';

// Import required bot services.
// See https://aka.ms/bot-services to learn more about the different parts of a bot.
import {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  ConfigurationBotFrameworkAuthentication,
  MemoryStorage,
  TeamsSSOTokenExchangeMiddleware,
  TurnContext,
} from 'botbuilder';

// This bot's main dialog.
import { TeamsBot } from './teamsBot';
import config from './config';
import { UserService } from './services/userService';
import { FetchUserMiddleware } from './services/fetchUserMiddleware';
import {
  parseRewardRequest,
  resolveAmountSats,
  assertRepoConnected,
  payReward,
  RewardError,
} from './services/rewardsService';
import { createAllowanceTopupHandler } from './services/allowanceTopup';

// Create adapter.
// See https://aka.ms/about-bot-adapter to learn more about adapters.
const tenantId = config.tenantId;
if (!tenantId) {
  throw new Error(
    'AAD_APP_TENANT_ID is not set. A SingleTenant bot registration cannot authenticate without it.',
  );
}

const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: config.botId,
  MicrosoftAppPassword: config.botPassword,
  MicrosoftAppType: 'SingleTenant',
  MicrosoftAppTenantId: tenantId,
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

// Catch-all for errors.
const onTurnErrorHandler = async (context: TurnContext, error: Error) => {
  // Retrieve user information
  const userId = context.activity.from.id;
  const aadObjectId = context.activity.from.aadObjectId;
  const userName = context.activity.from.name;

  // Log user information
  console.log(`User ID: ${userId}`);
  console.log(`User AAD Object ID: ${aadObjectId}`);
  console.log(`User Display Name: ${userName}`);

  // This check writes out errors to console log .vs. app insights.
  // NOTE: In production environment, you should consider logging this to Azure
  //       application insights.
  console.error(`\n [onTurnError] unhandled error: ${error}`);

  // Send a trace activity, which will be displayed in Bot Framework Emulator
  await context.sendTraceActivity(
    'OnTurnError Trace',
    `${error}`,
    'https://www.botframework.com/schemas/error',
    'TurnError',
  );

  // Send a message to the user
  await context.sendActivity(
    `The bot encountered unhandled error:\n ${error.message}`,
  );
  await context.sendActivity(
    'To continue to run this bot, please fix the bot source code.',
  );
};

// Set the onTurnError for the singleton CloudAdapter
adapter.onTurnError = onTurnErrorHandler;

// Create the bot that will handle incoming messages.
const bot = new TeamsBot();

// Create HTTP server. Express instead of restify: restify still requires
// spdy, whose native http_parser binding no longer exists on Node >= 21.
const server = express();

// Azure App Service fronts the bot with a single proxy; without this the
// limiter would key every client on the proxy's IP.
server.set('trust proxy', 1);

const DEFAULT_API_RATE_LIMIT = 30;

// Named for the bot specifically: the tabs backend reads API_RATE_LIMIT with a
// browser-sized default, and one shared name would silently apply the wrong
// budget to whichever process is configured second. A malformed value falls
// back to the default rather than to `Number()`'s NaN, which would disable the
// limit entirely.
const botApiRateLimit = (): number => {
  const configured = process.env.BOT_API_RATE_LIMIT?.trim();
  if (!configured) {
    return DEFAULT_API_RATE_LIMIT;
  }
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.warn(
      `BOT_API_RATE_LIMIT must be a positive integer; using ${DEFAULT_API_RATE_LIMIT}`,
    );
    return DEFAULT_API_RATE_LIMIT;
  }
  return parsed;
};

// The API routes are called by schedulers and automations, never by browsers,
// so a tight window is plenty and CodeQL's js/missing-rate-limiting is
// satisfied by a recognised middleware.
const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: botApiRateLimit(),
  standardHeaders: true,
  legacyHeaders: false,
});
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

// A presented key is valid if it matches the env key or the hash of any
// active portal-managed key (created and revoked by admins in Automations).
const isAuthorizedRewardKey = async (providedKey: string): Promise<boolean> => {
  const envKey = process.env.REWARDS_API_KEY;
  if (envKey) {
    // Buffers, not strings: timingSafeEqual throws on byte-length mismatch.
    const provided = Buffer.from(providedKey);
    const expected = Buffer.from(envKey);
    if (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    ) {
      return true;
    }
  }
  const hashes = await getWebhookKeyHashes();
  if (!envKey && hashes.length === 0) {
    throw new RewardError(
      'rewards endpoint disabled: no API keys configured',
      503,
    );
  }
  const providedHash = createHash('sha256').update(providedKey).digest('hex');
  return hashes.includes(providedHash);
};

// Deterministic automation path — no LLM can trigger a payment here.
server.post('/api/v1/rewards', apiRateLimiter, async (req, res) => {
  try {
    if (!(await isAuthorizedRewardKey(req.header('x-api-key') ?? ''))) {
      res.status(401).json({ error: 'invalid API key' });
      return;
    }
  } catch (error) {
    if (error instanceof RewardError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    console.error('rewards key validation failed:', error);
    res.status(503).json({ error: 'rewards endpoint unavailable' });
    return;
  }

  try {
    const request = parseRewardRequest(req.body);
    // This draft endpoint is deliberately restricted to GitHub. Generic flow
    // identities need a separate provider-aware contract before they can pay.
    await assertRepoConnected(request.repo);
    const amountSats = await resolveAmountSats(request);
    const result = await payReward({ ...request, amountSats });
    if ('pending' in result) {
      res.status(202).json({
        status: 'pending',
        recipient: request.recipient,
        amountSats,
      });
      return;
    }
    res.status(200).json({
      status: 'paid',
      paymentHash: result.paymentHash,
      recipient: request.recipient,
      amountSats,
    });
  } catch (error) {
    if (error instanceof RewardError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    // Internals (env names, LNbits ids) must not leak into Logic App run history.
    console.error('rewards payment failed:', error);
    res.status(500).json({ error: 'internal error' });
  }
});

// Weekly allowance sweep-and-refill, fired by an external scheduler (e.g. an
// Azure Logic App). Same key contract as /api/v1/rewards; a re-fired trigger
// inside the same ISO week is answered with {skipped: true} instead of
// sweeping wallets twice.
server.post(
  '/api/v1/allowance/topup',
  apiRateLimiter,
  createAllowanceTopupHandler({ isAuthorized: isAuthorizedRewardKey }),
);

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
