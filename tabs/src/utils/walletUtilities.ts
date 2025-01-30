import { getAllWallets, getWalletTransactionsSince } from '../services/lnbitsServiceLocal';
import { useCache } from './CacheContext';

//import { Wallet, ZapTransaction } from 'path-to-types';

export const fetchAllowanceWalletTransactions = async (adminKey: string): Promise<Transaction[]> => {
  const wallets = await getAllWallets(adminKey);
  console.log('Wallets: ', wallets);

  let allZaps: Transaction[] = [];

  if (wallets) {
    const allowanceWallets = wallets.filter(wallet => wallet.name === 'Allowance');

    for (const wallet of allowanceWallets) {
      const transactions = await getWalletTransactionsSince(wallet.inkey, 0, { tag: 'zap' });
      allZaps = allZaps.concat(transactions);
    }
  } else {
    console.log('No wallets found for user: ');
  }

  return allZaps;
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
