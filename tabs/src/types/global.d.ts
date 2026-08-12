// src/types/global.d.ts

interface Reward {
  id: string;
  image: string;
  name: string;
  shortDescription: string;
  link: string;
  price: number;
}

interface UserAccount {
  id: string;
  is_super_user: boolean;
  is_admin: boolean;
  username: string;
  email: string;
  balance_msat: number;
  transaction_count: number;
  wallet_count: number;
  last_payment: string;
}

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
  type: UserType;
  privateWallet: Wallet | null;
  allowanceWallet: Wallet | null;
}

type UserType = 'Teammate' | 'Copilot' | 'Guest';

type WalletType = 'Allowance' | 'Private';

interface Transaction {
  checking_id: string;
  pending: boolean;
  amount: number; // in millisatoshis (msats)
  fee: number;
  memo: string;
  time: number | string; // Unix timestamp (number) or ISO date string
  extra: { [key: string]: any }; // JSON object
  wallet_id: string;
  bolt11?: string; // Lightning invoice (optional)
}

interface Allowance {
  id: string;
  name: string;
  wallet: string;
  toWallet: string;
  amount: number;
  startDate: date;
  endDate: date | null;
  frequency: AllowanceFrequency;
  nextPaymentDate: date;
  lastPaymentDate: date | null;
  memo: string | null;
  active: boolean;
}

declare module '*.module.css' {
  const classes: { [key: string]: string };
  export default classes;
}

declare module '*.svg' {
  const content: any;
  export default content;
}

declare module '*.png' {
  const content: any;
  export default content;
}

declare module 'qrcode.react' {
  import { ComponentType } from 'react';
  const QRCode: ComponentType<any>;
  export default QRCode;
}

declare module '*.gif' {
  const value: string;
  export default value;
}
