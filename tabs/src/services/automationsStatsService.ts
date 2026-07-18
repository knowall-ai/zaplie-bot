import axios from 'axios';

export interface AutomationsStats {
  paidSatsThisMonth: number;
  paymentsThisMonth: number;
}

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
export const getAutomationsStats = async (idToken: string): Promise<AutomationsStats> => {
  const response = await axios.get('/api/automations-stats', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.data;
};
