import { SSOCommand } from './SSOCommandMap';
import {
  TurnContext,
  ActivityTypes,
  Activity,
  CardFactory,
  MessageFactory,
  ConversationParameters,
} from 'botbuilder';
import { ConnectorClient } from 'botframework-connector';
import { getUsers, payInvoice, createInvoice, getWalletBalance } from '../services/lnbitsService';
import { UserService } from '../services/userService';
import { getRewardName } from '../services/fetchRewardsName';

const adminKey = process.env.LNBITS_ADMINKEY as string;
const lnbitsLabel = process.env.REACT_APP_LNBITS_POINTS_LABEL as string;

export class SendZapCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    try {

      console.log("Running SendZapCommand's execute method.");

     // Fetch the latest reward name
      const globalRewardName = await getRewardName();
      console.log('Fetched Reward Name:', globalRewardName);

      // Await the createZapCard function and log the result
      const currentUser = context.turnState.get('user');
      const card = await createZapCard(currentUser, globalRewardName);
      console.log('createZapCard:', card); // Log the card content

      // Create the message with the adaptive card
      const message = MessageFactory.attachment(CardFactory.adaptiveCard(card));
      console.log('Message Content:', message); // Log the message content

      // Send the adaptive card message
      await context.sendActivity(message);
      console.log('sendActivity completed.');
    } catch (error) {
      await context.sendActivity(
        'Oops! Something went wrong (' + error.message + ')',
      );
    }
  }
}

export async function SendZap(
  sender: User,
  receiver: User,
  zapMessage: string,
  zapAmount: number,
  context: TurnContext,
  updateCard: boolean = true,
  globalRewardName: string
): Promise<void> {
  try {
    console.log('Sending zap ...');

    // Validate that the sender has enough balance
    const currentBalance = sender.allowanceWallet.balance_msat / 1000; // Convert msat to sat
    if (zapAmount > currentBalance) {
      //await context.sendActivity(
      //  `D'oh! You cannot send more than your available balance. Your current balance is ${currentBalance} Sats.`,
      //);
      throw new Error(`D'oh! You cannot send more than your available balance. Your current balance is ${currentBalance} ${globalRewardName}.`);
      //return; // Stop further processing
    }

    // Extra information to be logged for tracking from which wallet the zap is sent from and to whom
    const extra = {
      from: sender.allowanceWallet,
      to: receiver.privateWallet,
      tag: 'zap',
    };

    // Create an invoice for the amount in the recipient's wallet
    const paymentRequest = await createInvoice(
      receiver.privateWallet.inkey,
      receiver.privateWallet.id,
      zapAmount,
      zapMessage,
      extra,
    );

    console.log('Payment Request:', paymentRequest);

    if (!paymentRequest) {
      throw new Error('Failed to create an invoice.');
    }

    // Pay the invoice

    console.log('sendersWallet: ', sender.allowanceWallet);

    const result = await payInvoice(
      sender.allowanceWallet.adminkey,
      paymentRequest,
      extra,
    );

    console.log('Payment Result:', result);

    if (result && result.payment_hash && updateCard) {
      // Updated adaptive card (read-only)
      //fetch remainingBalance
      const remainingBalance = await getWalletBalance(sender.allowanceWallet.inkey);
      console.log('Remaining Balance:', remainingBalance);
      
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
            type: 'ColumnSet',
            columns: [
              {
                type: 'Column',
                width: 'auto',
                items: [
                  {
                    type: 'TextBlock',
                    text: `Receiver:`,
                    weight: 'Bolder', 
                  },
                ],
              },
              {
                type: 'Column',
                width: 'stretch',
                items: [
                  {
                    type: 'TextBlock',
                    text: `${receiver.displayName}`, 
                  },
                ],
              },
            ],
          },
          {
            type: 'ColumnSet',
            columns: [
              {
                type: 'Column',
                width: 'auto',
                items: [
                  {
                    type: 'TextBlock',
                    text: `Message:`,
                    weight: 'Bolder',
                  },
                ],
              },
              {
                type: 'Column',
                width: 'stretch',
                items: [
                  {
                    type: 'TextBlock',
                    text: `${zapMessage}`,
                  },
                ],
              },
            ],
          },
          {
            type: 'ColumnSet',
            columns: [
              {
                type: 'Column',
                width: 'auto',
                items: [
                  {
                    type: 'TextBlock',
                    text: `Amount (${globalRewardName}):`,
                    weight: 'Bolder',
                  },
                ],
              },
              {
                type: 'Column',
                width: 'stretch',
                items: [
                  {
                    type: 'TextBlock',
                    text: `${zapAmount}`,
                  },
                ],
              },
              {
                type: 'ColumnSet',
                columns: [
                  {
                    type: 'Column',
                    width: 'auto',
                    items: [
                      {
                        type: 'TextBlock',
                        text: `Remaining Amount (${globalRewardName}):`,
                        weight: 'Bolder',
                      },
                    ],
                  },
                  {
                    type: 'Column',
                    width: 'stretch',
                    items: [
                      {
                        type: 'TextBlock',
                        text: `${remainingBalance}`,
                      },
                    ],
                  },
                ],
              }
            ],
          },
        ],
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.2',
      };

      // Update responsive card in message
      const updatedMessage = MessageFactory.attachment(
        CardFactory.adaptiveCard(updatedCard),
      );

      updatedMessage.id = context.activity.replyToId; // The ID of the current message is used.
      await context.updateActivity(updatedMessage);

      console.log('Adaptive card updated to read-only.');
    }

    try {
      await messageRecipient(sender, receiver, zapAmount, zapMessage, context);
    } catch (error) {
      console.error(
        'Failed to send a message to the recipient. (' + error.message + ')',
      );
    }

    try {
      await messageRecipient(sender, receiver, zapAmount, zapMessage, context);
    } catch (error) {
      console.error(
        'Failed to send a message to the recipient. (' + error.message + ')',
      );
    }

    // TODO: Errors here are not being caught for some reason. Need to fix this. Mario.

    /*
    if (result && result.payment_hash) {
      const mention = {
        mentioned: {
          id: userId,
          name: userName,
        },
        text: `<at>${userName}</at>`,
        type: 'mention',
      };

      await context.sendActivity(
        `Successfully sent ${amount} zap to ${userName}.`,
      );
    } else {
      await context.sendActivity('Failed to pay the invoice.');
    }
      */
  } catch (error) {
    throw new Error(error.message);
  }
}

// Function to create an adaptive card
async function createZapCard(sender: User, globalRewardName: string) {
  console.log('Creating Zap Card ...');
  const walletChoices = await populateWalletChoices();

  // TODO: Add the users current balance to here!
  const currentBalance = await getWalletBalance(sender.allowanceWallet.inkey);

  const cardBody = [
    {
      type: 'Input.ChoiceSet',
      label: 'Receiver',
      id: 'zapReceiverId',
      placeholder: 'Select one or more recipient wallets',
      choices: walletChoices,
      isRequired: true,
      isMultiSelect: true,
      errorMessage: 'You must select at least one person to zap',
    },
    {
      type: 'Input.Text',
      label: `Message`,
      size: 'medium',
      id: 'zapMessage',
      isRequired: true,
      placeholder: 'Thanks for helping me with the proposal!',
      errorMessage: 'You should tell them why you are zapping them',
    },
    {
      type: 'Input.Text',
      id: 'zapAmount',
      placeholder: '100',
      label: `Amount (${globalRewardName})`,
      regex: '^(?:10000|[1-9][0-9]{0,3})$',
      isRequired: true,
      errorMessage: `You must specify an amount between 1 and 10,000 ${lnbitsLabel}`,
    },
    {
      type: 'TextBlock',
      text: `**Current Available Balance (${globalRewardName}):** ${currentBalance}`,
      wrap: true,
      color: 'Good',
    },
  ];

  /*
  // Add people picker input if globalMentionedUserName is null or undefined
  if (!globalMentionedUserName) {
    cardBody.unshift({
      type: 'Input.ChoiceSet',
      id: 'recipient',
      placeholder: 'Select a person to send zaps to',
      choices: [], // Initialize choices as an empty array
      choicesData: { // Use choicesData instead of data
        type: "Data.Query",
        dataset: "graph.microsoft.com/users"
      }
    });
  }*/
  
  return {
    type: 'AdaptiveCard',
    body: cardBody,
    actions: [
      {
        type: 'Action.Submit',
        title: 'Send Zap',
        data: {
          action: 'submitZaps',
        },
      },
    ],
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
  };
}

// Function to populate choices
async function populateWalletChoices() {
  console.log('Populating wallet choices ...');
  const users = await getUsers(adminKey, null);

  // Get the current user
  const userService = UserService.getInstance();
  const currentUser = userService.getCurrentUser();

  let filteresUsers = users;
  if (currentUser) {
    filteresUsers = users.filter(
      user => user?.aadObjectId !== userService.getCurrentUser().aadObjectId,
    );
  }

  if (filteresUsers) {
    return filteresUsers.map((user: any) => ({
      title: user.displayName,
      value: user.id,
    }));
  }
  return [];
}

// This method will only work if:
// 1. The user has installed the bot, the admin admin has installed the bot for that user.
// And possibly:
// 2. The user has sent a message to the bot (not sure if "continueConversationAsync" will work if the user has not sent a message to the bot).
// Ref: https://github.com/OfficeDev/microsoft-teams-apps-company-communicator/blob/207013db2ad64ac5c3d365fd4db1a25fd2d703cf/Source/CompanyCommunicator.Common/Services/Teams/Conversations/ConversationService.cs#L70
async function messageRecipient(
  sender: User,
  receiver: User,
  zapAmount: number,
  zapMessage: string,
  context: TurnContext,
): Promise<void> {
  try {
    // Get the bot's App ID, name, and credentials
    const botAppId =
      process.env.MicrosoftAppId || context.activity.recipient.id;
    const botName = context.activity.recipient.name;
    //const botCredentials = (context.adapter as any).credentials;

    /*
    console.log(
      ' process.env.SECRET_AAD_APP_CLIENT_SECRET:',
      process.env.SECRET_AAD_APP_CLIENT_SECRET,
    );

    // Create the credentials using MicrosoftAppCredentials
    const botCredentials = new MicrosoftAppCredentials(
      botAppId,
      process.env.SECRET_AAD_APP_CLIENT_SECRET, // Is this password encrypted?
    );*/
    
    console.log('Bot App ID:', botAppId);
    console.log('Bot Name:', botName);

    // Construct the Teams user ID using the AAD Object ID
    const receiverTeamsId = `29:${receiver.aadObjectId}`;

    // Clone the existing activity and modify it
    const reference = TurnContext.getConversationReference(context.activity);
    const botMessage: Partial<Activity> =
      TurnContext.applyConversationReference(
        {
          type: ActivityTypes.Message,
          text: `You have received ${zapAmount} ${lnbitsLabel} from ${sender.displayName} with a message: "${zapMessage}"`,
        },
        reference,
        true,
      );

    // Modify the message to set the recipient as the receiver and clear irrelevant fields
    botMessage.recipient = {
      id: receiverTeamsId,
      name: receiver.displayName,
      aadObjectId: receiver.aadObjectId,
    };
    botMessage.from = {
      id: botAppId,
      name: botName,
    };
    botMessage.conversation = undefined; // Clear conversation ID as it will be set upon conversation creation
    botMessage.replyToId = undefined;

    // Create the ConnectorClient
    /*
    const connectorClient = new ConnectorClient(botCredentials, {
      baseUri: context.activity.serviceUrl,
    });*/
    //const connectorClient = await context.adapter.createConnectorClient(context.activity.serviceUrl);
    /*
    const adapter = context.adapter as CloudAdapter;
    const connectorClient = await adapter.createConnectorClient(
      context.activity.serviceUrl,
    );*/

    const connectorClient = context.turnState.get(
      context.adapter.ConnectorClientKey,
    ) as ConnectorClient;

    if (!connectorClient) {
      throw new Error('ConnectorClient is not available in turn state.');
    }

    // Create a conversation with the recipient
    const conversationParameters: ConversationParameters = {
      isGroup: false,
      bot: {
        id: botAppId,
        name: botName,
      },
      members: [
        {
          id: receiverTeamsId,
          name: receiver.displayName,
          aadObjectId: receiver.aadObjectId,
        },
      ],
      tenantId: context.activity.conversation.tenantId,
      channelData: {
        tenant: {
          id: context.activity.conversation.tenantId,
        },
      },
      activity: botMessage as Activity, // Include the initial message here
    };

    // Create the conversation ... or Adapter.CreateConversationAsync????
    /*
    const response = await connectorClient.conversations.createConversation(
      conversationParameters,
    );
    */
    // Create the message
    const message = MessageFactory.text(
      `You have received ${zapAmount} ${lnbitsLabel} from ${sender.displayName} with a message: "${zapMessage}"`,
    );

    // Send the message to the new conversation
    /* 
    await connectorClient.conversations.sendToConversation(
      response.id,
      message,
    );
    */
  } catch (error) {
    if (
      error.statusCode === 403 ||
      error.message.includes('Bot not in conversation roster')
    ) {
      // Inform the sender that the recipient hasn't installed the bot
      /* await context.sendActivity(
         `FYI I wasn't able to message ${receiver.displayName} that they have a zap from you because they don't have me installed yet - maybe you could ping them, and let them know to install Zaplie!`,
      );
    } else {*/
      console.error('Error in messageRecipient:', error);
      throw error;
    }
  }
}