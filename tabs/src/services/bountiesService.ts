import axios from 'axios';

const API_URL = '/api/bounties';

export interface BountySubmission {
  id: string;
  aad: string;
  name: string;
  note: string;
  submittedAt: string;
}

export interface BountyObjective {
  aad: string;
  setAt: string;
}

export interface Bounty {
  id: string;
  title: string;
  description: string;
  amountSats: number;
  difficulty: 'easy' | 'intermediate' | 'high';
  category: string;
  deadlineAt: string | null;
  status: 'open' | 'claimed' | 'paid' | 'cancelled';
  createdAt: string;
  submissions: BountySubmission[];
  objectives: BountyObjective[];
  winnerSubmissionId: string | null;
  claimantAad: string | null;
  claimantName: string | null;
  claimedAt: string | null;
  paymentHash: string | null;
  paidAt: string | null;
}

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
const auth = (idToken: string) => ({
  headers: { Authorization: `Bearer ${idToken}` },
});

export const getBounties = async (idToken: string): Promise<Bounty[]> => {
  const response = await axios.get(API_URL, auth(idToken));
  return response.data.bounties;
};

export const createBounty = async (
  idToken: string,
  bounty: {
    title: string;
    description: string;
    amountSats: number;
    difficulty?: 'easy' | 'intermediate' | 'high';
    category?: string;
    deadlineDays?: number;
  },
): Promise<Bounty> => {
  const response = await axios.post(API_URL, bounty, auth(idToken));
  return response.data;
};

export const submitToBounty = async (
  idToken: string,
  id: string,
  note: string,
): Promise<Bounty> => {
  const response = await axios.post(
    `${API_URL}/${id}/submissions`,
    { note },
    auth(idToken),
  );
  return response.data;
};

export const toggleBountyObjective = async (
  idToken: string,
  id: string,
): Promise<Bounty> => {
  const response = await axios.post(
    `${API_URL}/${id}/objective`,
    null,
    auth(idToken),
  );
  return response.data;
};

export const payBounty = async (
  idToken: string,
  id: string,
  submissionId?: string,
): Promise<Bounty> => {
  const response = await axios.post(
    `${API_URL}/${id}/pay`,
    submissionId ? { submissionId } : null,
    auth(idToken),
  );
  return response.data;
};

export const cancelBounty = async (
  idToken: string,
  id: string,
): Promise<Bounty> => {
  const response = await axios.post(
    `${API_URL}/${id}/cancel`,
    null,
    auth(idToken),
  );
  return response.data;
};
