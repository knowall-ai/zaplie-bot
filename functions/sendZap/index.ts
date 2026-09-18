import { AzureFunction, Context, HttpRequest } from "@azure/functions";
import { createInvoice, payInvoice, getUser} from '../services/lnbitsService';
import { getCredentials } from '../services/utils';
import { ZapPaymentExtra, toPaymentExtraWallet } from '../services/paymentExtra';

const automateZap: AzureFunction = async function (context: Context, req: HttpRequest): Promise<void> {
    context.log('Started Sending zap ...');

    try {
        interface ZapRequestBody {
            senderWalletId: string;
            receiverWalletId: string;
            zapAmount: number;
            zapMessage: string;
            tag: string;
        }

        const { senderWalletId, receiverWalletId, zapAmount, zapMessage, tag } = req.body as ZapRequestBody;

        // Log the request body
        context.log('Request Body:', req.body);

        // Create an invoice for the receiver
        
        const { adminKey } = getCredentials(req);

        // Getting Wallet details fro sender and receiver

  

        // Get details for the sender

        const sender = await getUser(req, senderWalletId, adminKey);
        const senderPrivateWallet = await filterPrivateWallet(sender);
        const senderAllowanceWallet = await filterAllowanceWallet(sender);   

        // Get details for the receiver

        // Users and wallets carry keys, so only ids are logged.
        context.log('Getting receiver details', receiverWalletId);
        const receiver = await getUser(req,receiverWalletId, adminKey);
        const receiverPrivateWallet = await filterPrivateWallet(receiver);

        // Same projection the bot writes: never a wallet object or a key.
        const extra: ZapPaymentExtra = {
            tag: 'zap',
            from: toPaymentExtraWallet(senderAllowanceWallet, 'sender Allowance', sender.displayName),
            to: toPaymentExtraWallet(receiverPrivateWallet, 'receiver Private', receiver.displayName),
        };

        const invoice = await createInvoice(req,receiverPrivateWallet.inkey, senderAllowanceWallet.id, zapAmount, zapMessage, extra);
        context.log('Invoice created:', invoice);

        // Pay the invoice using the sender's wallet
       context.log('Paying invoice ...');
       const paymentResult = await payInvoice(req, adminKey, invoice,extra);
       // context.log('Invoice paid:', paymentResult);

        context.res = {
            status: 200,
            body: {
                message: 'Zap sent successfully',
                invoice,
                paymentResult
            }
        };
    } catch (error) {
        context.res = {
            status: 500,
            body: `Error: ${error.message}`
        };
    }
};

function filterPrivateWallet(user: any): any {
    console.log('User Receiver:', user);
    if (!user || !user.wallets) {
        console.log('No wallets found for user.');
        return null;
    }

    const privateWallet = user.wallets.find((wallet: any) => wallet.name === 'Private');
    if (!privateWallet) {
        console.log('No private wallet found for user.');
    } else {
        console.log('Private Wallet:', privateWallet);
    }

    return privateWallet;
}

function filterAllowanceWallet(user: any): any {
    console.log('User Sender:', user);
    return user.wallets.find((wallet: any) => wallet.name === 'Allowance');
}


export default automateZap;