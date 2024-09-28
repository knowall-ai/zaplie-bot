import { SSOCommand, SSOCommandMap } from './SSOCommandMap';
import {
  TeamsActivityHandler,
  TurnContext,
  SigninStateVerificationQuery,
  MemoryStorage,
  ConversationState,
  UserState,
  CardFactory,
  Middleware,
  MessageFactory,
} from 'botbuilder';
import {
  getUsers,
  payInvoice,
  getWalletIdByUserId,
  createInvoice,
} from '../services/lnbitsService';
import { error } from 'console';

const adminKey = process.env.LNBITS_ADMINKEY as string;

export class SendZapCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    try {
      console.log("Running SendZapCommand's execute method.");

      // Await the createZapCard function and log the result
      const card = await createZapCard();
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

/*
// Helper function to extract the amount from the message text
function extractAmountFromMessage(text: string): number {
  const amountMatch = text.match(/(\d+)/);
  return amountMatch ? parseInt(amountMatch[0], 10) : 0;
}
  */

export async function SendZap(
  sendersWallet: Wallet,
  receiversWallet: Wallet,
  zapMessage: string,
  zapAmount: number,
): Promise<void> {
  try {
    console.log('Sending zap ...');

    // Extra information to be logged for tracking from which wallet the zap is sent from and to whom
    const extra = {
      from: sendersWallet,
      to: receiversWallet,
      tag: 'zap',
    };

    // Create an invoice for the amount in the recipient's wallet
    const paymentRequest = await createInvoice(
      receiversWallet.inkey,
      receiversWallet.id,
      zapAmount,
      zapMessage,
      extra,
    );

    console.log('Payment Request:', paymentRequest);

    if (!paymentRequest) {
      throw new Error('Failed to create an invoice.');
    }

    // Pay the invoice

    console.log('sendersWallet: ', sendersWallet);

    const result = await payInvoice(
      sendersWallet.adminkey,
      paymentRequest,
      extra,
    );

    console.log('Payment Result:', result);

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
    throw new Error('Failed to send zaps. (' + error.message + ')');
  }
}

// Function to create an adaptive card
async function createZapCard() {
  console.log('Creating Zap Card ...');
  const walletChoices = await populateWalletChoices();

  // TODO: Add the users current balance to here!

  const cardBody = [
    {
      type: 'Input.ChoiceSet',
      label: 'Receiver',
      id: 'zapReceiverId',
      placeholder: 'Select a recipient wallet',
      choices: walletChoices,
      isRequired: true,
      errorMessage: 'You must select someone to zap',
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
      type: 'Input.Number',
      id: 'zapAmount',
      placeholder: '100',
      label: 'Amount (Sats)',
      min: 1,
      max: 10000,
      isRequired: true,
      errorMessage: 'You must specify an amount between 1 and 10,000 Sats',
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
    version: '1.2',
  };
}

// Function to populate choices
async function populateWalletChoices() {
  console.log('Populating wallet choices ...');
  const users = await getUsers(adminKey, null);
  if (users) {
    return users.map((user: any) => ({
      title: user.displayName,
      value: user.id,
    }));
  }
  return [];
}
