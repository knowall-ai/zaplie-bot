// paymentExtra.ts (functions twin)
//
// Same projection as src/services/paymentExtra.ts in the bot, kept as a
// separate copy because the Azure Functions package builds on its own
// (see AGENTS.md, "three parallel clients"). Keep the two identical.
//
// LNbits stores the payment `extra` object as JSON that any holder of the
// receiving wallet's invoice key can read, so a Wallet object (adminkey,
// inkey, balance_msat) must never be serialised there.

export interface PaymentExtraWallet {
  id: string;
  name: string;
  user: string;
  displayName: string;
  adminkey?: never;
  inkey?: never;
  balance_msat?: never;
}

export interface ZapPaymentExtra {
  tag: 'zap';
  from: PaymentExtraWallet;
  to: PaymentExtraWallet;
}

export type PaymentExtraRole = 'sender Allowance' | 'receiver Private';

export function toPaymentExtraWallet(
  wallet: Wallet | null | undefined,
  role: PaymentExtraRole,
  displayName: string,
): PaymentExtraWallet {
  if (!wallet) {
    throw new Error(`Cannot build payment metadata: ${role} wallet is missing`);
  }

  return {
    id: wallet.id,
    name: wallet.name,
    user: wallet.user,
    displayName,
  };
}
