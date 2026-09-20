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
  ConversationParameters,
} from 'botbuilder';
import { SSOCommandMap } from './commands/SSOCommandMap';
import {
  SendZapCommand,
  SendZap,
  buildZapReceiptCard,
  createZapCard,
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
  GENERIC_ERROR_MESSAGE,
  UserFacingError,
  unrecognizedCommandGuide,
  welcomeMessage,
} from './messages';
import { runConversationalTurn } from './services/foundryAgentService';
import { createReadOnlyTools } from './commands/agentTools';
import { getUser, getUsers, getWalletBalance } from './services/lnbitsService';
import config from './config';

const UNRECOGNIZED_COMMAND_MESSAGE =
  "D'oh! I'm sorry, but I didn't recognize that command. But don't worry, I'm always getting better!";
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
            await context.sendActivity(
              'That zap card cannot be identified, so it was not submitted. Please start a new zap.',
            );
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
            throw new UserFacingError(
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
            throw new UserFacingError(
              'No valid recipients were selected, so no zaps were sent.',
            );
          }

          // The card marks the message required, but that check is client-side
          // and forgeable, and the message reaches both the invoice and the
          // receipt card.
          if (typeof zapMessage !== 'string' || zapMessage.trim() === '') {
            throw new UserFacingError(
              'Your zap needs a message, so no zaps were sent.',
            );
          }

          if (currentUser.id && receiverIds.includes(currentUser.id)) {
            throw new UserFacingError(
              'You cannot zap yourself, so no zaps were sent.',
            );
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
              ? 'One or more payments from this zap still need checking, so nothing was retried.'
              : 'That zap card was already submitted, so nothing was sent again.';
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
                  ? 'No zaps were confirmed.'
                  : 'No zaps were sent.',
                failedRecipients.length > 0
                  ? `Could not complete: ${failedRecipients.join(', ')}.`
                  : '',
                uncertainRecipients.length > 0
                  ? `Payment outcome uncertain for: ${uncertainRecipients.join(', ')} — an admin should verify before retrying.`
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
            const updatedCard = buildZapReceiptCard({
              recipients: successfulRecipients,
              failedRecipients,
              uncertainRecipients,
              message: zapMessage,
              amount,
              remainingBalance,
              rewardName: globalRewardName,
            });

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
            `Awesome! You sent ${amount} ${globalRewardName} to your colleague with a zap!`,
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
              unrecognizedCommandGuide(SSOCommandMap.commandNames()),
            );
          }
        }
      } catch (error) {
        console.error('Error in onMessage handler:', error);
        await context.sendActivity(
          error instanceof UserFacingError
            ? `D'oh! ${error.message}`
            : GENERIC_ERROR_MESSAGE,
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
          welcomeMessage(SSOCommandMap.commandNames()),
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
      await context.sendActivity(GENERIC_ERROR_MESSAGE);
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
  // "Zap a message" action command: right-click a message -> open a zap card
  // pre-filled for its author.
  //
  // Every reply is a task-module message, and the card itself is delivered to
  // the invoker's 1:1 chat with the bot. Nothing is posted into the source
  // conversation. Posting there would put a card carrying the invoker's own
  // Available Balance, and a live Send Zap button, in front of everyone in
  // the channel or group chat - and the zap ledger key (tenant, conversation,
  // card, recipient) is deliberately not scoped by sender, so whoever pressed
  // it first would pay from their own allowance and the invoker's own submit
  // would then be rejected as a duplicate.
  async handleTeamsMessagingExtensionSubmitAction(
    context: TurnContext,
    action: MessagingExtensionAction,
  ): Promise<MessagingExtensionActionResponse> {
    // FetchUserMiddleware sets 'user' on every turn or the turn throws before
    // reaching here. Typed as optional anyway: this handler owes Teams a
    // response, and an unhandled TypeError would surface as a bare dialog
    // failure with nothing said to the person.
    const currentUser: User | undefined = context.turnState.get('user');
    if (!currentUser) {
      return dialogMessage(
        "D'oh! I couldn't verify who you are, so I can't open a zap card.",
      );
    }

    const from = action.messagePayload?.from;
    if (from?.application && !from.user) {
      return dialogMessage(
        "D'oh! That message was posted by an app, not a person, so there's nobody to zap.",
      );
    }

    const authorUser = from?.user;
    if (!authorUser?.id) {
      return dialogMessage(
        "D'oh! I couldn't tell who sent that message, so I can't zap them.",
      );
    }

    let author: User | undefined;
    try {
      const users = await getUsers(adminKey, { aadObjectId: authorUser.id });
      author = users[0];
    } catch (error) {
      console.error(
        'Unable to resolve the message author in Zaplie:',
        error instanceof Error ? error.message : error,
      );
      return dialogMessage(
        "D'oh! I couldn't check that teammate's Zaplie account right now. Please try again later.",
      );
    }
    if (!author) {
      return dialogMessage(
        `D'oh! ${authorUser.displayName || 'That person'} doesn't have a Zaplie account yet.`,
      );
    }

    if (author.aadObjectId === currentUser.aadObjectId) {
      return dialogMessage(
        "D'oh! You can't zap yourself - the allowance is for recognising others.",
      );
    }

    // 'memo' comes from the static-parameter dialog Teams shows before this
    // invoke (manifest zapMessage command); empty means "use the message text".
    const dialogMemo =
      typeof action.data?.memo === 'string'
        ? capMemoPreview(action.data.memo.trim())
        : '';

    // createZapCard reads the wallet list and the sender's live balance, and
    // opening the 1:1 chat is a network call too. LNbits or Teams being down
    // must fail like the guards above - a sentence in the dialog - not as a
    // bare task-module error.
    try {
      const card = await createZapCard(currentUser, globalRewardName, {
        receiverId: author.id,
        receiverName: author.displayName,
        amountSats: ZAP_MESSAGE_DEFAULT_SATS,
        message:
          dialogMemo || htmlToMemoPreview(action.messagePayload?.body?.content),
      });
      await this.sendCardToInvoker(context, card);
    } catch (error) {
      console.error(
        'Unable to open a zap card for the message author:',
        error instanceof Error ? error.message : error,
      );
      return dialogMessage(
        "D'oh! I couldn't open a zap card just now. Check that you have Zaplie installed in a personal chat, then try again.",
      );
    }

    return dialogMessage(
      `Opened a zap card for ${author.displayName} in your chat with Zaplie. Nothing is sent until you press Send Zap there.`,
    );
  }

  // Delivers the pre-filled card to the invoker's 1:1 chat with the bot, so
  // only they can see their balance and only they can press Send Zap. The
  // card lands in a personal conversation, which also scopes the zap ledger
  // key to that conversation.
  private async sendCardToInvoker(
    context: TurnContext,
    card: Awaited<ReturnType<typeof createZapCard>>,
  ): Promise<void> {
    const botAppId = config.botId;
    if (!botAppId) {
      throw new Error('BOT_ID is not set, so no 1:1 chat can be opened.');
    }
    // Teams stamps the tenant on the conversation for most activities and only
    // in channelData for some; read both rather than guess.
    const channelData = context.activity.channelData as
      { tenant?: { id?: string } } | undefined;
    const tenantId =
      context.activity.conversation?.tenantId ?? channelData?.tenant?.id;
    if (!tenantId) {
      throw new Error('No tenant id on the zap-message invoke.');
    }

    const message = MessageFactory.attachment(CardFactory.adaptiveCard(card));
    const conversationParameters: ConversationParameters = {
      isGroup: false,
      bot: context.activity.recipient,
      members: [context.activity.from],
      tenantId,
      channelData: { tenant: { id: tenantId } },
    };

    await context.adapter.createConversationAsync(
      botAppId,
      context.activity.channelId,
      context.activity.serviceUrl,
      '',
      conversationParameters,
      async (proactive: TurnContext) => {
        await proactive.sendActivity(message);
      },
    );
  }
}

// Teams shows this in the invoker's own dialog, so it reaches the person who
// used the action and nobody else in the conversation.
function dialogMessage(value: string): MessagingExtensionActionResponse {
  return { task: { type: 'message', value } };
}

// Prefill only: the user can still edit the amount on the card, whose input
// regex enforces 1..10,000.
const ZAP_MESSAGE_DEFAULT_SATS = 1000;

// Both memo sources - the dialog field and the extracted message text - go
// through this one cap. Nothing in the manifest bounds the dialog field, and
// the memo reaches the LNbits invoice and the receipt card, so an unbounded
// one would travel further than the card. It is a prefill the user can still
// edit, so an over-long memo is trimmed rather than refused.
const MEMO_PREVIEW_MAX_CODE_POINTS = 80;

// Counted in code points, not UTF-16 code units: slicing a string mid
// surrogate pair leaves a lone half that renders as a replacement character.
function capMemoPreview(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= MEMO_PREVIEW_MAX_CODE_POINTS) return text;
  return codePoints.slice(0, MEMO_PREVIEW_MAX_CODE_POINTS).join('').trimEnd();
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

// The memo is a plain-text Adaptive Card value, never rendered as HTML, so we
// extract text (strip tags, decode entities) instead of sanitizing. Entities
// are decoded after tag removal so "&lt;b&gt;" stays the literal text "<b>".
function htmlToMemoPreview(html: string | undefined): string {
  if (!html) return '';
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g,
      (entity, body: string) => {
        if (body[0] === '#') {
          const code =
            body[1] === 'x' || body[1] === 'X'
              ? parseInt(body.slice(2), 16)
              : parseInt(body.slice(1), 10);
          return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
        }
        return HTML_ENTITIES[body.toLowerCase()] ?? entity;
      },
    )
    .replace(/\s+/g, ' ')
    .trim();
  return capMemoPreview(stripMarkdownLinks(text));
}

// Adaptive Card TextBlocks render a subset of markdown, and the zap receipt
// card shows the memo back. Tags are already gone by this point, but
// "[our invoice portal](https://evil.example)" would still render as a live
// link on a receipt that is now seeded by somebody else's message. Keep the
// label, drop the target, then remove the brackets and backticks that could
// re-form one. Emphasis markers are left alone: they only change styling and
// stripping them would mangle ordinary prose.
function stripMarkdownLinks(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[[\]`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
