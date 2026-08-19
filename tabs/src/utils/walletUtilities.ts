import { getAllPayments } from '../services/lnbitsServiceLocal';

//import { Wallet, ZapTransaction } from 'path-to-types';

export const fetchAllowanceWalletTransactions = async (): Promise<
  Transaction[]
> => {
  const allPayments = await getAllPayments(10000);

  // Filter to only exclude system transactions like "Weekly Allowance cleared"
  // Don't filter by extra.tag since that field doesn't exist in the payment data
  return allPayments.filter(
    payment => !payment.memo?.includes('Weekly Allowance cleared'),
  );
};

export function getUserName(wallet: Wallet | null): string {
  let userName = null;
  try {
    if (!wallet) {
      return 'Unknown';
    }

    if (!wallet.name) {
      return 'Unknown';
    }

    if (wallet.name.includes(' - ')) {
      userName = wallet.name.split(' - ')[0];
      return userName;
    } else {
      return 'Unknown';
    }
  } catch (e) {
    return 'Unknown';
  }
}

export function getAadObjectId(wallet: Wallet): string {
  throw new Error('Not yet implemented.');
}

export function getWalletType(wallet: Wallet): string {
  throw new Error('Not yet implemented.');
}
