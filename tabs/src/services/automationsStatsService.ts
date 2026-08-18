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
  runsByEventType: Record<string, number>;
  engagementByAudience: Record<AutomationAudience, AutomationRecipient[]>;
  recentPayments: AutomationHistoryItem[];
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isRecipient = (value: unknown): value is AutomationRecipient => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<AutomationRecipient>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.displayName === 'string' &&
    (candidate.audience === 'teammates' ||
      candidate.audience === 'copilots' ||
      candidate.audience === 'customers') &&
    isFiniteNumber(candidate.paymentCount) &&
    isFiniteNumber(candidate.paidSats)
  );
};

export const parseAutomationsStats = (value: unknown): AutomationsStats => {
  if (!value || typeof value !== 'object') {
    throw new Error('Automations stats response is malformed.');
  }

  const candidate = value as Partial<AutomationsStats>;
  const engagement = candidate.engagementByAudience;
  const audiences: AutomationAudience[] = [
    'teammates',
    'copilots',
    'customers',
  ];
  const validEngagement =
    engagement &&
    audiences.every(
      audience =>
        Array.isArray(engagement[audience]) &&
        engagement[audience].every(isRecipient),
    );
  const validHistory =
    Array.isArray(candidate.recentPayments) &&
    candidate.recentPayments.every(
      payment =>
        payment &&
        typeof payment.id === 'string' &&
        isFiniteNumber(payment.amountSats) &&
        typeof payment.memo === 'string' &&
        typeof payment.source === 'string' &&
        isRecipient({
          ...payment.recipient,
          paymentCount: 0,
          paidSats: 0,
          lastPaidAt: null,
        }),
    );

  if (
    !isFiniteNumber(candidate.paidSatsThisMonth) ||
    !isFiniteNumber(candidate.paymentsThisMonth) ||
    !candidate.runsByEventType ||
    typeof candidate.runsByEventType !== 'object' ||
    !validEngagement ||
    !validHistory
  ) {
    throw new Error('Automations stats response is malformed.');
  }

  return candidate as AutomationsStats;
};

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
export const getAutomationsStats = async (
  idToken: string,
): Promise<AutomationsStats> => {
  const response = await axios.get('/api/automations-stats', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseAutomationsStats(response.data);
};
