import { SSOCommand } from './SSOCommandMap';
import { TurnContext, CardFactory, MessageFactory } from 'botbuilder';
import {
  getUsers,
  payInvoice,
  createInvoice,
  getWalletBalance,
} from '../services/lnbitsService';
import { UserService } from '../services/userService';

const adminKey = process.env.LNBITS_ADMINKEY as string;
const lnbitsLabel = process.env.LNBITS_POINTS_LABEL as string;

export class SendZapCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    try {
      console.log("Running SendZapCommand's execute method.");

      const globalRewardName = lnbitsLabel;

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

export interface SendZapResult {
  paymentHash: string;
}

// Thrown only once payInvoice has been called: at that point the payment may
// have settled even though we failed to confirm it, so a retry is unsafe.
export class PaymentOutcomeUnknownError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PaymentOutcomeUnknownError';
  }
}

export async function SendZap(
  sender: User,
  receiver: User,
  zapMessage: string,
  zapAmount: number,
  context: TurnContext,
  updateCard: boolean = true,
  globalRewardName: string,
): Promise<SendZapResult> {
  try {
    console.log('Sending zap ...');

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

    if (!paymentRequest) {
      throw new Error('Failed to create an invoice.');
    }

    // Pay the invoice

    let result;
    try {
      result = await payInvoice(
        sender.allowanceWallet.adminkey,
        paymentRequest,
        extra,
      );
    } catch (error) {
      throw new PaymentOutcomeUnknownError(
        'The payment request failed after being sent to LNbits.',
        error,
      );
    }

    if (!result?.payment_hash) {
      throw new PaymentOutcomeUnknownError(
        'The payment returned no payment hash, so it cannot be confirmed.',
      );
    }
    const paymentHash: string = result.payment_hash;

    console.log('Payment result: settled');

    if (result && result.payment_hash && updateCard) {
      // Updated adaptive card (read-only)
      //fetch remainingBalance
      const remainingBalance = await getWalletBalance(
        sender.allowanceWallet.inkey,
      );
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
              },
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

    return { paymentHash };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error));
  }
}

export interface ZapCardPrefill {
  receiverId: string;
  amountSats: number;
  message: string;
}

// Function to create an adaptive card
export async function createZapCard(
  sender: User,
  globalRewardName: string,
  prefill?: ZapCardPrefill,
) {
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
      ...(prefill && { value: prefill.receiverId }),
    },
    {
      type: 'Input.Text',
      label: `Message`,
      size: 'medium',
      id: 'zapMessage',
      isRequired: true,
      placeholder: 'Thanks for helping me with the proposal!',
      errorMessage: 'You should tell them why you are zapping them',
      ...(prefill && { value: prefill.message }),
    },
    {
      type: 'Input.Text',
      id: 'zapAmount',
      placeholder: '100',
      label: `Amount (${globalRewardName})`,
      regex: '^(?:10000|[1-9][0-9]{0,3})$',
      isRequired: true,
      errorMessage: `You must specify an amount between 1 and 10,000 ${lnbitsLabel}`,
      ...(prefill && { value: String(prefill.amountSats) }),
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

/**
 * Builds selectable wallet choices from available users.
 *
 * @returns Wallet choices containing each user's display name and ID, excluding the current user when available.
 */
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
    return filteresUsers.map(user => ({
      title: user.displayName,
      value: user.id,
    }));
  }
  return [];
}
