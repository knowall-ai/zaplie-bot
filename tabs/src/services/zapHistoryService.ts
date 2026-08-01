import { getUsers, getUserWallets, getWalletTransactionsSince } from './lnbitsServiceLocal';

export interface ZapHistory {
  allUsers: User[];
  zappedUserIds: Set<string>;
}

// Recipient id lives in transaction.extra.to.user — the same field FeedList.tsx reads.
export async function fetchZapHistory(
  adminKey: string,
  currentUserAadObjectId: string,
  sinceEpochSeconds: number,
): Promise<ZapHistory> {
  const allUsers = await getUsers(adminKey, {});
  if (!allUsers) {
    throw new Error('LNbits getUsers returned null');
  }

  const currentUser = allUsers.find(u => u.aadObjectId === currentUserAadObjectId);
  if (!currentUser) {
    return { allUsers, zappedUserIds: new Set() };
  }

  const wallets = await getUserWallets(adminKey, currentUser.id);
  const allowanceWallet = wallets?.find(w => w.name.toLowerCase().includes('allowance'));
  if (!allowanceWallet) {
    return { allUsers, zappedUserIds: new Set() };
  }

  const transactions = await getWalletTransactionsSince(
    allowanceWallet.inkey,
    sinceEpochSeconds,
    null,
  );

  const zappedUserIds = new Set<string>();
  transactions
    .filter(t => t.amount < 0 && !t.memo?.includes('Weekly Allowance cleared'))
    .forEach(t => {
      const recipientId = t.extra?.to?.user;
      if (recipientId) {
        zappedUserIds.add(recipientId);
      }
    });

  return { allUsers, zappedUserIds };
}
