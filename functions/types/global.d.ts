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