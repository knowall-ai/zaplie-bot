import {
  TeamsActivityHandler,
  TurnContext,
  SigninStateVerificationQuery,
  MemoryStorage,
  ConversationState,
  UserState,
  StatePropertyAccessor,
  CardFactory,
  MessageFactory,
  MessagingExtensionAction,
  MessagingExtensionActionResponse,
} from 'botbuilder';
import { SSOCommandMap } from './commands/SSOCommandMap';
import {
  SendZapCommand,
  SendZap,
  createZapCard,
} from './commands/sendZapCommand';
import { ZapLedger, zapKey } from './services/zapLedger';
import {
  getPendingRecipientIds,
  hasUnknownRecipientOutcome,
  normalizeRecipientIds,
  processZapRecipient,
  validateSelfZap,
} from './commands/zapRecipient';
import { validateZapSubmit } from './commands/zapBudget';
import { ShowMyBalanceCommand } from './commands/showMyBalanceCommand';
import { WithdrawFundsCommand } from './commands/withdrawFundsCommand';
import { ShowLeaderboardCommand } from './commands/showLeaderboardCommand';
import {
  CONNECT_CALENDAR_COMMAND,
  ConnectCalendarCommand,
  getStoredGraphToken,
} from './commands/connectCalendarCommand';
import { runConversationalTurn } from './services/foundryAgentService';
import { createAgentTools } from './commands/agentTools';
import { getUser, getUsers, getWalletBalance } from './services/lnbitsService';

const UNRECOGNIZED_COMMAND_MESSAGE =
  "D'oh! I'm sorry, but I didn't recognize that command. But don't worry, I'm always getting better!";

//Reward Name Constants

const globalRewardName: string = process.env.LNBITS_POINTS_LABEL as string;
if (!globalRewardName) {
  throw new Error(
    'LNBITS_POINTS_LABEL is not set. Configure it in env/.env.dev (propagated to the bot by scripts/writeEnv.js).',
  );
}

const adminKey = process.env.LNBITS_ADMINKEY as string;

export class TeamsBot extends TeamsActivityHandler {
  conversationState: ConversationState;
  userState: UserState;
  foundryConversationIdAccessor: StatePropertyAccessor<string | undefined>;
  // Best-effort, single-process protection against paying a recipient twice
  // from the same card. Not durable: see the note in zapLedger.ts.
  private zapLedger = new ZapLedger();

  constructor() {
    super();

    // Define the state store for your bot.
    const memoryStorage = new MemoryStorage();
    // Create conversation and user state with in-memory storage provider.
    this.conversationState = new ConversationState(memoryStorage);
    this.userState = new UserState(memoryStorage);
    this.foundryConversationIdAccessor = this.conversationState.createProperty<
      string | undefined
    >('foundryConversationId');

    // Register commands
    SSOCommandMap.register('send zap', new SendZapCommand());
    SSOCommandMap.register('show my balance', new ShowMyBalanceCommand());
    SSOCommandMap.register('withdraw my zaps', new WithdrawFundsCommand());
    SSOCommandMap.register('show leaderboard', new ShowLeaderboardCommand());
    if (process.env.GRAPH_CONNECTION_NAME) {
      SSOCommandMap.register(
        CONNECT_CALENDAR_COMMAND,
        new ConnectCalendarCommand(),
      );
    }

    this.onMessage(async (context, next) => {
      console.log('Running onMessage ...');
      const botId = context.activity.recipient.id; // Bot's ID
      const senderId = context.activity.from.id; // Sender's ID

      // Check if the sender is the bot itself
      if (senderId === botId) {
        // Skip processing the bot's own messages
        await next();
        return;
      }

      try {
        let textMessage = context.activity.text || '';
        const mentions = TurnContext.getMentions(context.activity);

        // Check if the bot is mentioned
        const botMentioned = mentions.some(
          mention => mention.mentioned.id === botId,
        );

        const failedRecipients: string[] = [];

        if (botMentioned) {
          // Remove the mention from the text
          mentions.forEach(mention => {
            if (mention.mentioned.id === botId) {
              textMessage = textMessage.replace(mention.text, '').trim();
            }
          });
        }

        if (
          context.activity.value &&
          context.activity.value.action === 'submitZaps'
        ) {
          const cardId = context.activity.replyToId;
          // Without a card id there is nothing to key the ledger on, so a
          // double submit could not be told apart from a legitimate one.
          if (!cardId) {
            await context.sendActivity(
              'That zap card cannot be identified, so it was not submitted. Please start a new zap.',
            );
            return;
          }
          const keyFor = (recipientId: string) =>
            zapKey({
              tenantId: context.activity.conversation.tenantId,
              conversationId: context.activity.conversation.id,
              cardId,
              recipientId,
            });

          const currentUser: User | undefined = context.turnState.get('user');
          const receiverIds = normalizeRecipientIds(
            context.activity.value.zapReceiverId,
          );

          const zapMessage = context.activity.value.zapMessage;
          const zapAmount = context.activity.value.zapAmount;

          const sendingWallet = currentUser?.allowanceWallet;
          if (!currentUser || (!currentUser.id && !currentUser.aadObjectId)) {
            throw new Error(
              'Could not verify your sender identity, so no zaps were sent.',
            );
          }
          if (
            !sendingWallet?.id ||
            !sendingWallet.inkey ||
            !sendingWallet.adminkey
          ) {
            throw new Error('No sending wallet found.');
          }

          if (receiverIds.length === 0) {
            throw new Error(
              'No valid recipients were selected, so no zaps were sent.',
            );
          }

          if (currentUser.id && receiverIds.includes(currentUser.id)) {
            throw new Error('You cannot zap yourself, so no zaps were sent.');
          }

          const pendingReceiverIds = getPendingRecipientIds(
            this.zapLedger,
            receiverIds,
            keyFor,
          );
          const handledSubmitMessage = () =>
            hasUnknownRecipientOutcome(this.zapLedger, receiverIds, keyFor)
              ? 'One or more payments from this zap still need checking, so nothing was retried.'
              : 'That zap card was already submitted, so nothing was sent again.';
          if (pendingReceiverIds.length === 0) {
            await context.sendActivity(handledSubmitMessage());
            return;
          }

          const liveBalance = await getWalletBalance(sendingWallet.inkey);
          const amount = validateZapSubmit(
            zapAmount,
            pendingReceiverIds.length,
            liveBalance,
            globalRewardName,
          );

          const successfulRecipients: string[] = [];
          const alreadyHandled: string[] = [];

          for (const recId of pendingReceiverIds) {
            const outcome = await processZapRecipient({
              ledger: this.zapLedger,
              entryKey: keyFor(recId),
              recipientId: recId,
              getReceiver: () => getUser(adminKey, recId),
              validateReceiver: receiver =>
                validateSelfZap(currentUser, receiver),
              pay: receiver =>
                SendZap(
                  currentUser,
                  receiver as User,
                  zapMessage,
                  amount,
                  context,
                  false,
                  globalRewardName,
                ),
            });

            if (outcome.status === 'skipped') {
              alreadyHandled.push(recId);
            } else if (outcome.status === 'paid') {
              successfulRecipients.push(outcome.label);
            } else if (outcome.status === 'needs-checking') {
              failedRecipients.push(`${outcome.label} (needs checking)`);
            } else {
              failedRecipients.push(outcome.label);
            }
          }

          // Every recipient was skipped, so this is a duplicate submit and
          // there is nothing new to report.
          if (alreadyHandled.length === pendingReceiverIds.length) {
            await context.sendActivity(handledSubmitMessage());
            return;
          }

          // Nothing was paid this time: the card must not turn green.
          if (successfulRecipients.length === 0) {
            await context.sendActivity(
              `No zaps were sent. Could not complete: ${failedRecipients.join(', ')}`,
            );
            return;
          }
          const bulletReceivers = successfulRecipients
            .map(name => `- ${name}`)
            .join('\n');

          const bulletFailed = failedRecipients.length
            ? failedRecipients.map(name => `- ${name}`).join('\n')
            : 'None';

          //fetch remainingBalance
          const remainingBalance = await getWalletBalance(
            currentUser.allowanceWallet.inkey,
          );
          console.log('Remaining Balance:', remainingBalance);

          const totalAmountSent = successfulRecipients.length * amount;

          // Update adaptive card to read-only with list of recipients
          const updatedCard = {
            type: 'AdaptiveCard',
            body: [
              {
                type: 'TextBlock',
                text: `Zap sent!`,
                weight: 'Bolder',
                size: 'Large',
                color: 'Good',
              },
              {
                type: 'TextBlock',
                text: `**Successful Receivers:**\n${bulletReceivers}`,
                wrap: true,
              },
              ...(failedRecipients.length > 0
                ? [
                    {
                      type: 'TextBlock',
                      text: `**Failed Receivers:**\n${bulletFailed}`,
                      wrap: true,
                      color: 'Attention',
                    },
                  ]
                : []),
              {
                type: 'TextBlock',
                text: `**Message:** ${zapMessage}`,
                wrap: true,
              },
              {
                type: 'TextBlock',
                text: `**Amount (${globalRewardName}):** ${amount}`,
                wrap: true,
              },

              {
                type: 'TextBlock',
                text: `Total Amount (Sats): ${totalAmountSent}`,
                wrap: true,
                color: 'Good',
              },
              {
                type: 'TextBlock',
                text: `**Remaining Amount (${globalRewardName}):** ${remainingBalance}`,
                wrap: true,
                color: 'Good',
              },
            ],
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.2',
          };

          const updatedMessage = MessageFactory.attachment(
            CardFactory.adaptiveCard(updatedCard),
          );
          updatedMessage.id = context.activity.replyToId;
          await context.updateActivity(updatedMessage);
          await context.sendActivity(
            `Awesome! You sent ${amount} ${globalRewardName} to your colleague with a zap!`,
          );
        }

        // Trigger command by IM text
        if (textMessage) {
          const command = SSOCommandMap.get(textMessage.toLowerCase());
          if (command) {
            await command.execute(context);
          } else if (
            context.activity.conversation.conversationType === 'personal'
          ) {
            // Free text with no exact command match falls back to the
            // conversational agent, but only in 1:1 chats: ConversationState
            // (and therefore the Foundry conversation) is keyed per
            // conversation, so a team or groupchat would otherwise share one
            // agent thread across unrelated teammates.
            await this.replyConversationally(context, textMessage);
          } else {
            await context.sendActivity(UNRECOGNIZED_COMMAND_MESSAGE);
          }
        }
      } catch (error) {
        console.error('Error in onMessage handler:', error.message);
        await context.sendActivity(`${error.message}`);
      }

      await next();
    });
  }

  async run(context: TurnContext) {
    try {
      await super.run(context);

      // Save any state changes. The load happened during the execution of the Dialog.
      await this.conversationState.saveChanges(context, false);
      await this.userState.saveChanges(context, false);
    } catch (error) {
      console.error('Error in run method:', error);
      await context.sendActivity(error);
    }
  }

  private async replyConversationally(
    context: TurnContext,
    textMessage: string,
  ): Promise<void> {
    const existingConversationId = await this.foundryConversationIdAccessor.get(
      context,
      undefined,
    );
    try {
      const result = await runConversationalTurn(
        textMessage,
        existingConversationId,
        createAgentTools(),
        context,
      );
      await this.foundryConversationIdAccessor.set(
        context,
        result.foundryConversationId,
      );
      await context.sendActivity(
        result.replyText || UNRECOGNIZED_COMMAND_MESSAGE,
      );
    } catch (error) {
      // A failed turn can leave a dangling/invalid Foundry conversation id; clear
      // it so the next message starts fresh. Then rethrow — a broken agent must
      // surface as a real error, not be disguised as "unrecognized command".
      await this.foundryConversationIdAccessor.set(context, undefined);
      throw error;
    }
  }

  async handleTeamsSigninVerifyState(
    context: TurnContext,
    query: SigninStateVerificationQuery,
  ) {
    if (!process.env.GRAPH_CONNECTION_NAME) return;
    const token = await getStoredGraphToken(context, query.state);
    await context.sendActivity(
      token
        ? 'Work signals connected — ask me about recent meetings or collaborators!'
        : `Sign-in could not be completed. Type "${CONNECT_CALENDAR_COMMAND}" to try again.`,
    );
  }

  async handleTeamsSigninTokenExchange(
    _context: TurnContext,
    _query: SigninStateVerificationQuery,
  ) {
    try {
      // Your logic here for handling token exchange
    } catch (error) {
      console.error('Error in handleTeamsSigninTokenExchange:', error);
    }
  }

  // "Zap a message" action command: right-click a message -> pre-fill a zap card for its author.
  async handleTeamsMessagingExtensionSubmitAction(
    context: TurnContext,
    action: MessagingExtensionAction,
  ): Promise<MessagingExtensionActionResponse> {
    const currentUser = context.turnState.get('user');
    if (!currentUser) {
      await context.sendActivity(
        "D'oh! I couldn't find your Zaplie account. Message me directly first to get set up.",
      );
      return {};
    }

    const authorUser = action.messagePayload?.from?.user;
    if (!authorUser?.id) {
      await context.sendActivity(
        "D'oh! I couldn't tell who sent that message, so I can't zap them.",
      );
      return {};
    }

    const users = await getUsers(adminKey, null);
    const author = users?.find(user => user.aadObjectId === authorUser.id);
    if (!author) {
      await context.sendActivity(
        `D'oh! ${authorUser.displayName || 'That person'} doesn't have a Zaplie account yet.`,
      );
      return {};
    }

    if (author.aadObjectId === currentUser.aadObjectId) {
      await context.sendActivity(
        "D'oh! You can't zap yourself - the allowance is for recognising others.",
      );
      return {};
    }

    const card = await createZapCard(currentUser, globalRewardName, {
      receiverId: author.id,
      amountSats: getZapMessageDefaultSats(),
      message: stripHtmlSnippet(action.messagePayload?.body?.content),
    });

    await context.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(card)),
    );

    return {};
  }
}

// HTML -> plaintext, capped to a short preview for the zap memo field.
function stripHtmlSnippet(html: string | undefined): string {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').trim().slice(0, 80);
}

function getZapMessageDefaultSats(): number {
  const raw = process.env.ZAP_MESSAGE_DEFAULT_SATS ?? '1000';
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`ZAP_MESSAGE_DEFAULT_SATS must be a positive integer, got "${raw}".`);
  }
  return amount;
}
