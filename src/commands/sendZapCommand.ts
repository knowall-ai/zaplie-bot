import { SSOCommand } from './SSOCommandMap';
import { TurnContext, CardFactory, MessageFactory } from 'botbuilder';
import {
  getUsers,
  payInvoice,
  createInvoice,
  getWalletBalance,
} from '../services/lnbitsService';
import { UserService } from '../services/userService';
import { GENERIC_ERROR_MESSAGE } from '../messages';

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
      // The details belong in the logs: an LNbits error message can carry
      // wallet ids or configuration names into the chat.
      console.error('SendZapCommand failed:', error);
      await context.sendActivity(GENERIC_ERROR_MESSAGE);
    }
  }
}

export interface SendZapResult {
  paymentHash: string;
}

export interface ZapReceipt {
  recipients: string[];
  failedRecipients?: string[];
  // Recipients whose payment was sent but never confirmed. They are NOT
  // failures: the money may already have moved, so they get their own section
  // instead of an invitation to retry.
  uncertainRecipients?: string[];
  message: string;
  amount: number;
  remainingBalance: number;
  rewardName: string;
}

// One key/value row of the receipt: bold label on the left, value on the
// right. Kept flat — a ColumnSet must only ever contain Columns.
const receiptRow = (label: string, value: string) => ({
  type: 'ColumnSet',
  columns: [
    {
      type: 'Column',
      width: 'auto',
      items: [
        {
          type: 'TextBlock',
          text: label,
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
          text: value,
          wrap: true,
        },
      ],
    },
  ],
});

// The read-only receipt a zap card turns into once a submit finishes. It
// reports the recipients this submit processed — recipients already settled by
// an earlier submit of the same card are not repeated here.
export function buildZapReceiptCard(receipt: ZapReceipt) {
  const {
    recipients,
    failedRecipients = [],
    uncertainRecipients = [],
    message,
    amount,
    remainingBalance,
    rewardName,
  } = receipt;

  const receiverLabel = recipients.length > 1 ? 'Receivers:' : 'Receiver:';
  const totalAmountSent = recipients.length * amount;
  const bulletList = (names: string[]): string =>
    names.map(name => `- ${name}`).join('\n');

  return {
    type: 'AdaptiveCard',
    body: [
      {
        type: 'TextBlock',
        text: 'Zap sent!',
        weight: 'Bolder',
        size: 'Large',
        color: 'Good',
      },
      receiptRow(receiverLabel, recipients.join(', ')),
      ...(failedRecipients.length > 0
        ? [
            {
              type: 'TextBlock',
              text: `**Failed Receivers:**\n${bulletList(failedRecipients)}`,
              wrap: true,
              color: 'Attention',
            },
          ]
        : []),
      // Kept apart from the failures on purpose: these payments were sent and
      // may well have settled, so listing them as failed would invite a retry
      // that pays the same person twice.
      ...(uncertainRecipients.length > 0
        ? [
            {
              type: 'TextBlock',
              text:
                `**Needs checking:**\n${bulletList(uncertainRecipients)}\n` +
                'Payment outcome uncertain — an admin should verify before ' +
                'retrying.',
              wrap: true,
              color: 'Warning',
            },
          ]
        : []),
      receiptRow('Message:', message),
      receiptRow(`Amount (${rewardName}):`, amount.toLocaleString()),
      ...(recipients.length > 1
        ? [
            receiptRow(
              `Total Sent (${rewardName}):`,
              totalAmountSent.toLocaleString(),
            ),
          ]
        : []),
      receiptRow(
        `Remaining Amount (${rewardName}):`,
        remainingBalance.toLocaleString(),
      ),
    ],
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
  };
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

      const updatedCard = buildZapReceiptCard({
        recipients: [receiver.displayName],
        message: zapMessage,
        amount: zapAmount,
        remainingBalance,
        rewardName: globalRewardName,
      });

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
