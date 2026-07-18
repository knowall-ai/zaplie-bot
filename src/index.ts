// Import required packages
import * as restify from 'restify';
import * as path from 'path';
import { timingSafeEqual } from 'crypto';

// Import required bot services.
// See https://aka.ms/bot-services to learn more about the different parts of a bot.
import {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  ConfigurationBotFrameworkAuthentication,
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
  payReward,
  RewardError,
} from './services/rewardsService';

// Create adapter.
// See https://aka.ms/about-bot-adapter to learn more about adapters.
const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: config.botId,
  MicrosoftAppPassword: config.botPassword,
  MicrosoftAppType: 'MultiTenant',
});

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(
  {},
  credentialsFactory,
);

const adapter = new CloudAdapter(botFrameworkAuthentication);

// Add EnsureUserSetupMiddleware to the adapter's middleware pipeline
// Create UserService instance (using the singleton pattern)
const userService = UserService.getInstance();

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

// Create HTTP server.
const server = restify.createServer();
server.use(restify.plugins.bodyParser());
server.listen(process.env.port || process.env.PORT || 3978, () => {
  console.log(`\nBot Started, ${server.name} listening to ${server.url}`);
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

// Deterministic automation path — no LLM can trigger a payment here.
server.post('/api/v1/rewards', async (req, res) => {
  const expectedKey = process.env.REWARDS_API_KEY;
  if (!expectedKey) {
    res.send(503, { error: 'rewards endpoint disabled: REWARDS_API_KEY is not set' });
    return;
  }
  // Buffers, not strings: timingSafeEqual throws on byte-length mismatch.
  const providedKey = Buffer.from(req.header('x-api-key') ?? '');
  const expected = Buffer.from(expectedKey);
  const keyMatches =
    providedKey.length === expected.length &&
    timingSafeEqual(providedKey, expected);
  if (!keyMatches) {
    res.send(401, { error: 'invalid API key' });
    return;
  }

  try {
    const request = parseRewardRequest(req.body);
    const amountSats = await resolveAmountSats(request);
    const result = await payReward({ ...request, amountSats });
    if ('pending' in result) {
      res.send(202, {
        status: 'pending',
        recipient: request.recipient,
        amountSats,
      });
      return;
    }
    res.send(200, {
      status: 'paid',
      paymentHash: result.paymentHash,
      recipient: request.recipient,
      amountSats,
    });
  } catch (error) {
    if (error instanceof RewardError) {
      res.send(error.statusCode, { error: error.message });
      return;
    }
    // Internals (env names, LNbits ids) must not leak into Logic App run history.
    console.error('rewards payment failed:', error);
    res.send(500, { error: 'internal error' });
  }
});

server.get(
  '/auth-:name(start|end).html',
  restify.plugins.serveStatic({
    directory: path.join(__dirname, '../public'),
  }),
);