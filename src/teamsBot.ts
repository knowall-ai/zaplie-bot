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
} from 'botbuilder';
import { SSOCommandMap } from './commands/SSOCommandMap';
import {
  SendZapCommand,
  SendZap,
  buildZapReceiptCard,
} from './commands/sendZapCommand';
import { ZapLedger, zapKey } from './services/zapLedger';
import {
  getPendingRecipientIds,
  hasUncertainRecipientOutcome,
  normalizeRecipientIds,
  processZapRecipient,
  validateSelfZap,
} from './commands/zapRecipient';
import { validateZapSubmit } from './commands/zapBudget';
import { ShowMyBalanceCommand } from './commands/showMyBalanceCommand';
import { ShowLeaderboardCommand } from './commands/showLeaderboardCommand';
import {
  CONNECT_CALENDAR_COMMAND,
  ConnectCalendarCommand,
  getStoredGraphToken,
} from './commands/connectCalendarCommand';
import {
  UserFacingError,
  genericErrorMessage,
  unrecognizedCommandGuide,
  welcomeMessage,
} from './messages';
import { resolveLocale, t } from './i18n';
import { runConversationalTurn } from './services/foundryAgentService';
import { createReadOnlyTools } from './commands/agentTools';
import { getUser, getWalletBalance } from './services/lnbitsService';

const ZAP_SUBMIT_ACTION = 'submitZaps';

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
  // Durable per-recipient protection against paying from the same card twice.
  // Construction fails outside development when ZAPLIE_DATA_DIR is absent.
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
    // "withdraw my zaps" is deliberately not registered (or listed in the
    // app manifests) until withdrawals actually work — see issue #293. The
    // command implementation is kept in commands/withdrawFundsCommand.ts.
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

      // The reply language follows the Teams client that sent the message.
      const locale = resolveLocale(context.activity.locale);

      try {
        let textMessage = context.activity.text || '';
        const mentions = TurnContext.getMentions(context.activity);

        // Check if the bot is mentioned
        const botMentioned = mentions.some(
          mention => mention.mentioned.id === botId,
        );

        const failedRecipients: string[] = [];
        // Kept separate from the failures: an unconfirmed payment may have
        // settled, so it must never be presented as something to retry.
        const uncertainRecipients: string[] = [];

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
          context.activity.value.action === ZAP_SUBMIT_ACTION
        ) {
          const cardId = context.activity.replyToId;
          // Teams usually stamps the tenant on the conversation, but some
          // activities carry it only in channelData. Read both before giving
          // up: the id is the same one, not a guess.
          const channelData = context.activity.channelData as
            { tenant?: { id?: string } } | undefined;
          const tenantId =
            context.activity.conversation.tenantId ?? channelData?.tenant?.id;
          const conversationId = context.activity.conversation.id;
          // All scope components are mandatory. Guessing a missing tenant,
          // conversation, or card id could merge unrelated submissions or
          // make a duplicate look new.
          if (!tenantId || !conversationId || !cardId) {
            await context.sendActivity(t(locale, 'zapCardUnidentified'));
            return;
          }
          const keyFor = (recipientId: string) =>
            zapKey({
              tenantId,
              conversationId,
              cardId,
              recipientId,
              action: ZAP_SUBMIT_ACTION,
            });

          const currentUser: User | undefined = context.turnState.get('user');
          const receiverIds = normalizeRecipientIds(
            context.activity.value.zapReceiverId,
          );

          const zapMessage = context.activity.value.zapMessage;
          const zapAmount = context.activity.value.zapAmount;

          const sendingWallet = currentUser?.allowanceWallet;
          if (!currentUser || (!currentUser.id && !currentUser.aadObjectId)) {
            throw new UserFacingError('senderUnverified');
          }
          if (
            !sendingWallet?.id ||
            !sendingWallet.inkey ||
            !sendingWallet.adminkey
          ) {
            throw new Error('No sending wallet found.');
          }

          if (receiverIds.length === 0) {
            throw new UserFacingError('noRecipients');
          }

          // The card marks the message required, but that check is client-side
          // and forgeable, and the message reaches both the invoice and the
          // receipt card.
          if (typeof zapMessage !== 'string' || zapMessage.trim() === '') {
            throw new UserFacingError('zapNeedsMessage');
          }

          if (currentUser.id && receiverIds.includes(currentUser.id)) {
            throw new UserFacingError('selfZap');
          }

          const pendingReceiverIds = await getPendingRecipientIds(
            this.zapLedger,
            receiverIds,
            keyFor,
          );
          const handledSubmitMessage = async () =>
            (await hasUncertainRecipientOutcome(
              this.zapLedger,
              receiverIds,
              keyFor,
            ))
              ? t(locale, 'submitStillChecking')
              : t(locale, 'submitAlreadyHandled');
          if (pendingReceiverIds.length === 0) {
            await context.sendActivity(await handledSubmitMessage());
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
              uncertainRecipients.push(outcome.label);
            } else {
              failedRecipients.push(outcome.label);
            }
          }

          // Every recipient was skipped, so this is a duplicate submit and
          // there is nothing new to report.
          if (alreadyHandled.length === pendingReceiverIds.length) {
            await context.sendActivity(await handledSubmitMessage());
            return;
          }

          // Nothing was confirmed this time: the card must not turn green.
          if (successfulRecipients.length === 0) {
            await context.sendActivity(
              [
                uncertainRecipients.length > 0
                  ? t(locale, 'noZapsConfirmed')
                  : t(locale, 'noZapsSent'),
                failedRecipients.length > 0
                  ? t(locale, 'couldNotComplete', {
                      recipients: failedRecipients.join(', '),
                    })
                  : '',
                uncertainRecipients.length > 0
                  ? t(locale, 'outcomeUncertain', {
                      recipients: uncertainRecipients.join(', '),
                    })
                  : '',
              ]
                .filter(Boolean)
                .join(' '),
            );
            return;
          }
          // Past this point the money has moved. Everything that follows is
          // presentation — a balance read and a card update — so a failure in
          // it must not reach the handler's catch and tell the user the zap
          // did not work. sendZapCommand isolates its post-settlement work the
          // same way, for the same reason.
          const updateReceiptCard = async (): Promise<void> => {
            //fetch remainingBalance
            const remainingBalance = await getWalletBalance(
              currentUser.allowanceWallet.inkey,
            );
            console.log('Remaining Balance:', remainingBalance);

            // Update the adaptive card to a read-only receipt for the
            // recipients this submit processed. Recipients already settled by
            // an earlier submit of the same card were skipped and are not
            // relisted.
            const updatedCard = buildZapReceiptCard(
              {
                recipients: successfulRecipients,
                failedRecipients,
                uncertainRecipients,
                message: zapMessage,
                amount,
                remainingBalance,
                rewardName: globalRewardName,
              },
              locale,
            );

            const updatedMessage = MessageFactory.attachment(
              CardFactory.adaptiveCard(updatedCard),
            );
            updatedMessage.id = context.activity.replyToId;
            await context.updateActivity(updatedMessage);
          };

          try {
            await updateReceiptCard();
          } catch (error) {
            console.error(
              'The zaps settled but the receipt card could not be updated; ' +
                'the payments stand and the ledger keeps them recorded as paid.',
              error,
            );
          }

          // Sent whether or not the card could be rewritten: the zaps really
          // were sent, and saying otherwise would be the wrong answer.
          await context.sendActivity(
            t(locale, 'zapSent', { amount, rewardName: globalRewardName }),
          );
        }

        // Trigger command by IM text. Matching is tolerant: whitespace is
        // collapsed and a message that starts with a known command (e.g.
        // "send zap to bob") runs that command.
        if (textMessage) {
          const command = SSOCommandMap.match(textMessage);
          if (command) {
            await command.execute(context);
          } else if (
            context.activity.conversation.conversationType === 'personal'
          ) {
            // Free text with no command match falls back to the
            // conversational agent, but only in 1:1 chats: ConversationState
            // (and therefore the Foundry conversation) is keyed per
            // conversation, so a team or groupchat would otherwise share one
            // agent thread across unrelated teammates.
            await this.replyConversationally(context, textMessage);
          } else {
            await context.sendActivity(
              unrecognizedCommandGuide(SSOCommandMap.commandNames(), locale),
            );
          }
        }
      } catch (error) {
        console.error('Error in onMessage handler:', error);
        await context.sendActivity(
          error instanceof UserFacingError
            ? t(locale, 'userFacingError', {
                message: error.localized(locale),
              })
            : genericErrorMessage(locale),
        );
      }

      await next();
    });

    // Welcome message when the bot itself is installed/added to a chat,
    // team or group conversation.
    this.onMembersAdded(async (context, next) => {
      const botId = context.activity.recipient?.id;
      const membersAdded = context.activity.membersAdded ?? [];
      if (membersAdded.some(member => member.id === botId)) {
        await context.sendActivity(
          welcomeMessage(
            SSOCommandMap.commandNames(),
            resolveLocale(context.activity.locale),
          ),
        );
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
      await context.sendActivity(
        genericErrorMessage(resolveLocale(context.activity.locale)),
      );
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
        createReadOnlyTools(),
        context,
      );
      await this.foundryConversationIdAccessor.set(
        context,
        result.foundryConversationId,
      );
      await context.sendActivity(
        result.replyText ||
          t(resolveLocale(context.activity.locale), 'agentNoReply'),
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
    const locale = resolveLocale(context.activity.locale);
    await context.sendActivity(
      token
        ? t(locale, 'workSignalsConnected')
        : t(locale, 'signInFailed', { command: CONNECT_CALENDAR_COMMAND }),
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
}
