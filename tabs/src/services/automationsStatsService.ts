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

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isAudience = (value: unknown): value is AutomationAudience =>
  value === 'teammates' || value === 'copilots' || value === 'customers';

const isRecipient = (value: unknown): value is AutomationRecipient => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<AutomationRecipient>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.displayName === 'string' &&
    isAudience(candidate.audience) &&
    isFiniteNumber(candidate.paymentCount) &&
    isFiniteNumber(candidate.paidSats) &&
    isNullableString(candidate.lastPaidAt)
  );
};

const isHistoryItem = (value: unknown): value is AutomationHistoryItem => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<AutomationHistoryItem>;
  const recipient = candidate.recipient;
  return (
    typeof candidate.id === 'string' &&
    isFiniteNumber(candidate.amountSats) &&
    typeof candidate.memo === 'string' &&
    typeof candidate.source === 'string' &&
    isNullableString(candidate.paidAt) &&
    Boolean(recipient) &&
    typeof recipient?.id === 'string' &&
    typeof recipient.displayName === 'string' &&
    isAudience(recipient.audience)
  );
};

const isNumberRecord = (value: unknown): value is Record<string, number> =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every(isFiniteNumber);

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
    candidate.recentPayments.every(isHistoryItem);

  if (
    !isFiniteNumber(candidate.paidSatsThisMonth) ||
    !isFiniteNumber(candidate.paymentsThisMonth) ||
    !isNumberRecord(candidate.runsByEventType) ||
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
