import axios from 'axios';

export type AutomationAudience = 'teammates' | 'copilots' | 'customers';

export interface AutomationRecipient {
  id: string;
  displayName: string;
  audience: AutomationAudience;
  paymentCount: number;
  paidSats: number;
  lastPaidAt: string | null;
}

export interface AutomationHistoryItem {
  id: string;
  amountSats: number;
  memo: string;
  source: string;
  paidAt: string | null;
  recipient: Pick<AutomationRecipient, 'id' | 'displayName' | 'audience'>;
}

export interface AutomationsStats {
  paidSatsThisMonth: number;
  paymentsThisMonth: number;
  engagementByAudience: Record<AutomationAudience, AutomationRecipient[]>;
  recentPayments: AutomationHistoryItem[];
}

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
export const getAutomationsStats = async (idToken: string): Promise<AutomationsStats> => {
  const response = await axios.get('/api/automations-stats', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.data;
};
