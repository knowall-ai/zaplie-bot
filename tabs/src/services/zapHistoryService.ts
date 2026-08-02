export interface ZapHistory {
  allUsers: User[];
  zappedUserIds: Set<string>;
}

interface ZapHistoryResponse {
  allUsers: Omit<User, 'privateWallet' | 'allowanceWallet'>[];
  zappedUserIds: string[];
}

// idToken as bearer follows the same convention as the other portal pages; a
// proper API access-token scope is pending the tab-backend auth redesign (#184).
export async function fetchZapHistory(
  idToken: string,
  sinceEpochSeconds: number,
): Promise<ZapHistory> {
  const response = await fetch(`/api/week/zap-history?sinceTs=${sinceEpochSeconds}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!response.ok) {
    throw new Error(`Zap history request failed (status: ${response.status})`);
  }
  const data: ZapHistoryResponse = await response.json();
  return {
    allUsers: data.allUsers.map(user => ({
      ...user,
      privateWallet: null,
      allowanceWallet: null,
    })),
    zappedUserIds: new Set(data.zappedUserIds),
  };
}
