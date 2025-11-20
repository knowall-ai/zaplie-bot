import { getAllPayments } from '../services/lnbitsServiceLocal';
import { useCache } from './CacheContext';

//import { Wallet, ZapTransaction } from 'path-to-types';

export const fetchAllowanceWalletTransactions = async (adminKey: string): Promise<Transaction[]> => {
  console.log('=== fetchAllowanceWalletTransactions DEBUG ===');
  console.log('Using getAllPayments endpoint to fetch ALL payments from ALL users');

  try {
    // Fetch ALL payments from ALL users using the new endpoint
    const allPayments = await getAllPayments(10000); // Get up to 10000 payments

    console.log('Total Payments Retrieved: ', allPayments.length);

    // Filter to only include "zap" transactions (exclude system transactions like "Weekly Allowance cleared")
    const zapTransactions = allPayments.filter(payment =>
      payment.extra?.tag === 'zap' &&
      !payment.memo?.includes('Weekly Allowance cleared')
    );

    console.log('Zap Transactions (filtered): ', zapTransactions.length);
    console.log('Sample transaction:', zapTransactions[0]);
    console.log('==============================================');

    return zapTransactions;
  } catch (error) {
    console.error('Error fetching all payments:', error);
    console.log('==============================================');
    throw error;
  }
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
