import axios from 'axios';

const API_URL = '/api/identities';

export interface LinkedIdentity {
  provider: string;
  providerId: string;
  providerHandle: string;
  linkedAt: string;
}

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
export const getMyIdentities = async (idToken: string): Promise<LinkedIdentity[]> => {
  const response = await axios.get(`${API_URL}/mine`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.data.identities;
};

export const getGithubAuthorizeUrl = async (idToken: string): Promise<string> => {
  const response = await axios.post(
    `${API_URL}/github/authorize-url`,
    {},
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  return response.data.authorizeUrl;
};
