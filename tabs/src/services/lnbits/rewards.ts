import { apiRequest } from './gateway';

const getNostrRewards = async (stallId: string): Promise<Reward[]> =>
  apiRequest<Reward[]>(`/rewards/${encodeURIComponent(stallId)}`);

export { getNostrRewards };
