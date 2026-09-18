// paymentExtra.ts
//
// Projects an LNbits Wallet into the fields allowed in payment metadata.
//
// LNbits stores the payment `extra` object as JSON on the payment row, where
// anyone holding the receiving wallet's invoice key can read it, and the
// portal feed loads it into every browser. A Wallet object carries adminkey,
// inkey and balance_msat, so it must never be serialised there. This helper
// picks fields by name on purpose: a new LNbits wallet field can never leak
// by accident, and every writer depends on this projection instead of on the
// Wallet type. The `never` members make a Wallet unassignable to the
// projection at compile time, so the type guards the rule as well.

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

// Prose for the error message only; the union documents who may call this.
export type PaymentExtraRole =
  | 'sender Allowance'
  | 'receiver Private'
  | 'recipient Private'
  | 'host Private';

/**
 * Builds the public projection of a wallet for LNbits payment metadata.
 *
 * @param wallet the sender's Allowance or the receiver's Private wallet
 * @param role   what the wallet is in this payment, used only in the error
 * @param displayName the label the portal shows next to the wallet
 * @throws when the wallet is missing, so no invoice is created for it
 */
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
