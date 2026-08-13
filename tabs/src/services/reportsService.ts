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

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
export const getReports = async (idToken: string): Promise<ReportsData> => {
  const response = await axios.get('/api/reports', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.data;
};
