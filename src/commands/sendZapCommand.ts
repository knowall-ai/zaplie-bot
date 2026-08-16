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
import { MAX_ZAP_SATS } from './zapBudget';
import {
  ZapPaymentExtra,
  toPaymentExtraWallet,
} from '../services/paymentExtra';

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

    // Metadata LNbits stores on the invoice and the payment so the portal
    // can show who zapped whom. Wallet objects carry keys, so only the
    // projection goes in, and a missing wallet fails before any LNbits call.
    const extra: ZapPaymentExtra = {
      tag: 'zap',
      from: toPaymentExtraWallet(
        sender.allowanceWallet,
        'sender Allowance',
        sender.displayName,
      ),
      to: toPaymentExtraWallet(
        receiver.privateWallet,
        'receiver Private',
        receiver.displayName,
      ),
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

    // Past this point the payment has settled and its hash is in hand, so
    // nothing that follows may reach the caller as a plain Error: that is the
    // signal for "never left this process", and it would release the ledger
    // entry and let a resubmit pay the same recipient again. Everything below
    // is presentation - a balance read and a card update - so a failure is
    // logged and the confirmed hash is still returned.
    const updateReceiptCard = async (): Promise<void> => {
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
    };

    if (updateCard) {
      try {
        await updateReceiptCard();
      } catch (error) {
        console.error(
          'The zap settled but its receipt card could not be updated; the ' +
            'payment stands and the ledger keeps it recorded as paid.',
          error,
        );
      }
    }

    return { paymentHash };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error), { cause: error });
  }
}

// A regex matching the whole numbers 1..cap, no leading zeros: the digit
// classes are built from the cap's digits, prefix by prefix. Used as the
// card's client-side rule because Teams refuses a regex mismatch with the
// errorMessage, whereas an Input.Number "max" is silently clamped on submit.
export const zapAmountRegex = (cap: number): string => {
  if (!Number.isInteger(cap) || cap < 1) {
    // Nothing is sendable: the field is required, so any value fails here.
    return '^$';
  }
  const digits = String(cap);
  const n = digits.length;
  const alternatives: string[] = [];
  if (n >= 2) {
    // Every number with fewer digits than the cap.
    alternatives.push(n === 2 ? '[1-9]' : `[1-9][0-9]{0,${n - 2}}`);
  }
  // Numbers with the cap's digit count that stay below it: same prefix, a
  // smaller digit at position i, anything after.
  for (let i = 0; i < n; i++) {
    const lowest = i === 0 ? 1 : 0;
    const highest = Number(digits[i]) - 1;
    if (highest < lowest) {
      continue;
    }
    const digit =
      lowest === highest ? String(lowest) : `[${lowest}-${highest}]`;
    const rest = n - i - 1;
    const tail = rest === 0 ? '' : rest === 1 ? '[0-9]' : `[0-9]{${rest}}`;
    alternatives.push(`${digits.slice(0, i)}${digit}${tail}`);
  }
  alternatives.push(digits);
  return `^(?:${alternatives.join('|')})$`;
};

// The amount input, capped at what the sender can actually send: the live
// Allowance balance, never above the hard ceiling. Teams checks the regex
// before the card can be submitted, so an amount the sender cannot afford is
// refused in the card, with the message below, instead of after a round trip.
// Forgeable like every client-side rule, so validateZapSubmit still enforces
// the amount and the cumulative budget on the server; a multi-recipient total
// is only enforced there. An unreadable balance falls back to the ceiling and
// leaves the refusal to the server, which reports it.
export const zapAmountInput = (liveBalance: number, rewardName: string) => {
  const cap = Number.isFinite(liveBalance)
    ? Math.max(0, Math.min(Math.floor(liveBalance), MAX_ZAP_SATS))
    : MAX_ZAP_SATS;
  const errorMessage =
    cap === 0
      ? `You have no ${rewardName} to send right now.`
      : cap < MAX_ZAP_SATS
        ? `Sorry, you don't have that many ${rewardName} to send! Enter a whole number up to ${cap.toLocaleString()}.`
        : `Enter a whole number between 1 and ${MAX_ZAP_SATS.toLocaleString()} ${rewardName}.`;
  return {
    type: 'Input.Text',
    id: 'zapAmount',
    placeholder: '100',
    label: `Amount (${rewardName})`,
    regex: zapAmountRegex(cap),
    isRequired: true,
    errorMessage,
  };
};

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

  const currentBalance = await getWalletBalance(sender.allowanceWallet.inkey);
  // A balance that cannot be read is the same failure as a rejected read:
  // no card, the generic error, nothing to fill in for nothing.
  if (!Number.isFinite(currentBalance)) {
    throw new Error(
      'The Allowance balance could not be read, so no zap card was built.',
    );
  }

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
      // The cap comes from the live balance (#409); propose_zap already
      // refuses an amount above it, so a prefilled value always satisfies
      // the card's own regex.
      ...zapAmountInput(currentBalance, globalRewardName),
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
    return filteresUsers.map(user => ({
      title: user.displayName,
      value: user.id,
    }));
  }
  return [];
}
