import { AzureFunction, Context, HttpRequest } from "@azure/functions";
import { createInvoice, payInvoice, getUser} from '../services/lnbitsService';
import { getCredentials } from '../services/utils';

export interface ZapRequestBody {
    senderWalletId: string;
    receiverWalletId: string;
    zapAmount: number;
    zapMessage: string;
    tag?: string;
}

const ALLOWED_BODY_KEYS = new Set([
    'senderWalletId',
    'receiverWalletId',
    'zapAmount',
    'zapMessage',
    'tag',
]);

const DEFAULT_ZAP_MAX_AMOUNT_SATS = 1_000_000;

export function getMaxZapAmount(): number {
    const envVal = process.env.ZAP_MAX_AMOUNT_SATS || process.env.REWARDS_MAX_AMOUNT_SATS;
    if (!envVal || envVal.trim() === '') {
        return DEFAULT_ZAP_MAX_AMOUNT_SATS;
    }
    const parsed = /^\d+$/.test(envVal.trim()) ? Number.parseInt(envVal.trim(), 10) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return DEFAULT_ZAP_MAX_AMOUNT_SATS;
    }
    return parsed;
}

export interface ValidationSuccess {
    valid: true;
    value: ZapRequestBody;
    error?: undefined;
}

export interface ValidationFailure {
    valid: false;
    error: string;
    value?: undefined;
}

export type ZapValidationResult = ValidationSuccess | ValidationFailure;

export function validateZapRequestBody(body: unknown): ZapValidationResult {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { valid: false, error: 'Request body must be a valid JSON object' };
    }

    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);

    const unknownKeys = keys.filter((key) => !ALLOWED_BODY_KEYS.has(key));
    if (unknownKeys.length > 0) {
        return { valid: false, error: `Unknown field(s) in request body: ${unknownKeys.join(', ')}` };
    }

    if (typeof record.senderWalletId !== 'string' || record.senderWalletId.trim() === '') {
        return { valid: false, error: 'senderWalletId must be a non-empty string' };
    }

    if (typeof record.receiverWalletId !== 'string' || record.receiverWalletId.trim() === '') {
        return { valid: false, error: 'receiverWalletId must be a non-empty string' };
    }

    if (typeof record.zapMessage !== 'string') {
        return { valid: false, error: 'zapMessage must be a string' };
    }

    if (record.tag !== undefined && typeof record.tag !== 'string') {
        return { valid: false, error: 'tag must be a string' };
    }

    if (
        typeof record.zapAmount !== 'number' ||
        !Number.isSafeInteger(record.zapAmount) ||
        record.zapAmount <= 0
    ) {
        return { valid: false, error: 'zapAmount must be a positive integer' };
    }

    const maxCap = getMaxZapAmount();
    if (record.zapAmount > maxCap) {
        return { valid: false, error: `zapAmount exceeds the configured maximum cap of ${maxCap}` };
    }

    return {
        valid: true,
        value: {
            senderWalletId: record.senderWalletId,
            receiverWalletId: record.receiverWalletId,
            zapAmount: record.zapAmount,
            zapMessage: record.zapMessage,
            tag: record.tag as string | undefined,
        },
    };
}

const automateZap: AzureFunction = async function (context: Context, req: HttpRequest): Promise<void> {
    context.log('Started Sending zap ...');

    // Log the request body
    context.log('Request Body:', req.body);

    const validation = validateZapRequestBody(req.body);
    if (!validation.valid) {
        context.res = {
            status: 400,
            body: `Invalid request body: ${validation.error}`,
        };
        return;
    }

    const { senderWalletId, receiverWalletId, zapAmount, zapMessage, tag } = validation.value;

    try {
        // Create an invoice for the receiver
        
        const { adminKey } = getCredentials(req);

        // Getting Wallet details fro sender and receiver

  

        // Get details for the sender

        const sender = await getUser(req, senderWalletId, adminKey);
        const senderPrivateWallet = await filterPrivateWallet(sender);
        const senderAllowanceWallet = await filterAllowanceWallet(sender);   

        // Get details for the receiver

        context.log('Getting Receiver details', adminKey, receiverWalletId);
        const receiver = await getUser(req,receiverWalletId, adminKey);
        context.log('Receiver:', receiver);
        const receiverPrivateWallet = await filterPrivateWallet(receiver);
        console.log('Alice Private wallet - ',receiverPrivateWallet);
       const receiverAllowanceWallet = await filterAllowanceWallet(receiver);
       context.log('Receiver Private Wallet:', receiverPrivateWallet);
        context.log('Receiver Allowance Wallet:', receiverAllowanceWallet);

 
        if (!senderAllowanceWallet || !receiverPrivateWallet) {
            context.res = {
                status: 400,
                body: 'Sender allowance wallet or receiver private wallet not found'
            };
            return;
        }

        const extra = { tag: 'zap', from: senderAllowanceWallet.inkey || '', to: receiverPrivateWallet.id };

        const invoice = await createInvoice(req, receiverPrivateWallet.inkey || '', senderAllowanceWallet.id, zapAmount, zapMessage, extra);
        context.log('Invoice created:', invoice);

        // Pay the invoice using the sender's wallet
        context.log('Paying invoice ...');
        const paymentResult = await payInvoice(req, adminKey, invoice, extra);
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
        const message = error instanceof Error ? error.message : String(error);
        context.res = {
            status: 500,
            body: `Error: ${message}`
        };
    }
};

interface UserWithWallets {
    wallets?: Wallet[];
}

function filterPrivateWallet(user: UserWithWallets | null | undefined): Wallet | null {
    console.log('User Receiver:', user);
    if (!user || !user.wallets) {
        console.log('No wallets found for user.');
        return null;
    }

    const privateWallet = user.wallets.find((wallet: Wallet) => wallet.name === 'Private');
    if (!privateWallet) {
        console.log('No private wallet found for user.');
    } else {
        console.log('Private Wallet:', privateWallet);
    }

    return privateWallet || null;
}

function filterAllowanceWallet(user: UserWithWallets | null | undefined): Wallet | null {
    console.log('User Sender:', user);
    return user?.wallets?.find((wallet: Wallet) => wallet.name === 'Allowance') || null;
}

export default automateZap;