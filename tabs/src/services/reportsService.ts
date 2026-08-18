import axios from 'axios';

export interface ReportsData {
  weeks: number;
  zapsWeekly: number[];
  automationWeekly: number[];
  totalZapSats: number;
  totalZapCount: number;
  totalAutomatedSats: number;
  totalAutomatedCount: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const parseReportsData = (value: unknown): ReportsData => {
  if (!value || typeof value !== 'object') {
    throw new Error('Reports response is malformed.');
  }

  const candidate = value as Partial<ReportsData>;
  const hasNumberSeries = (series: unknown): series is number[] =>
    Array.isArray(series) && series.every(isFiniteNumber);

  if (
    !Number.isInteger(candidate.weeks) ||
    !hasNumberSeries(candidate.zapsWeekly) ||
    !hasNumberSeries(candidate.automationWeekly) ||
    candidate.zapsWeekly.length !== candidate.weeks ||
    candidate.automationWeekly.length !== candidate.weeks ||
    !isFiniteNumber(candidate.totalZapSats) ||
    !isFiniteNumber(candidate.totalZapCount) ||
    !isFiniteNumber(candidate.totalAutomatedSats) ||
    !isFiniteNumber(candidate.totalAutomatedCount)
  ) {
    throw new Error('Reports response is malformed.');
  }

  return candidate as ReportsData;
};

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
export const getReports = async (idToken: string): Promise<ReportsData> => {
  const response = await axios.get('/api/reports', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseReportsData(response.data);
};
