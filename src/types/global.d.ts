// src/types/global.d.ts

interface Wallet {
  id: string;
  admin: string;
  name: string;
  user: string;
  adminkey: string;
  inkey: string;
  balance_msat: number;
  deleted: boolean;
}

interface User {
  id: string;
  displayName: string;
  profileImg: string;
  aadObjectId: string;
  email: string;
  privateWallet: Wallet | null;
  allowanceWallet: Wallet | null;
}

type WalletType = 'Allowance' | 'Private';

interface Transaction {
  checking_id: string;
  pending: boolean;
  amount: number; // in millisatoshis (msats)
  fee: number;
  memo: string;
  time: number | string; // Unix timestamp (number) or ISO date string
  extra: Record<string, unknown>; // JSON object
  wallet_id: string;
  bolt11?: string; // Lightning invoice (optional)
}
