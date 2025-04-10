import React, { createContext, useState, useEffect, ReactNode } from 'react';
import { getRewardName } from '../apiService';

interface RewardNameContextProps {
  rewardName: string | null;
  setRewardName: React.Dispatch<React.SetStateAction<string>>;
}

// Create the context
export const RewardNameContext = createContext<RewardNameContextProps>({
  rewardName: null,
  setRewardName: () => {},
});

export const RewardNameProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [rewardName, setRewardName] = useState<string>('');

  useEffect(() => {
    const fetchRewardName = async () => {
      try {
        const data = await getRewardName();
        console.log("Fetched Reward Name:", data); // Debugging log
        setRewardName(data?.rewardName || 'sats' ); // Fallback in case of missing data
      } catch (error) {
        console.error('Error fetching reward name:', error);
      }
    };

    fetchRewardName();
  }, []);

  if (!rewardName) {
    return null; // Return null if rewardName is not set yet
  }

  return (
    <RewardNameContext.Provider value={{ rewardName, setRewardName }}>
      {children}
    </RewardNameContext.Provider>
  );
};
