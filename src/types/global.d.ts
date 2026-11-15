// src/types/global.d.ts

interface Wallet {
  id: string;
  admin: string;
  name: string;
  user: string;
  adminkey: string;
  inkey: string;
  // Only known after a balance read; the directory does not send one.
  balance_msat?: number;
  deleted: boolean;
}

// A person in Zaplie's directory (src/services/peopleDirectory.ts). `id` and
// `aadObjectId` are both the Entra object id. The bot holds no wallet
// credential: the Allowance wallet is only an id (the portal pays from it over
// NWC), and the person's Private wallet is theirs, so a User only says whether
// they can receive.
interface AllowanceWalletRef {
  id: string;
}

interface User {
  id: string;
  displayName: string;
  profileImg: string;
  aadObjectId: string;
  email: string;
  allowanceWallet: AllowanceWalletRef | null;
  canReceive: boolean;
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
