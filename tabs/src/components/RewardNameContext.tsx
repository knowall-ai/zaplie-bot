import React, {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { getRewardName } from '../apiService';

interface RewardNameContextProps {
  rewardName: string | null;
  setRewardName: React.Dispatch<React.SetStateAction<string | null>>;
  isLoading?: boolean;
  error?: Error | null;
  retry?: () => void;
}

export const RewardNameContext = createContext<RewardNameContextProps>({
  rewardName: null,
  setRewardName: () => {},
  isLoading: true,
  error: null,
  retry: () => {},
});

export const RewardNameProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [rewardName, setRewardName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const loadRewardName = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const data = await getRewardName();
      if (requestId === requestIdRef.current) {
        setRewardName(data.rewardName);
      }
    } catch (loadError) {
      if (requestId === requestIdRef.current) {
        setError(
          loadError instanceof Error
            ? loadError
            : new Error('The reward name could not be loaded.'),
        );
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadRewardName();

    return () => {
      requestIdRef.current += 1;
    };
  }, [loadRewardName]);

  return (
    <RewardNameContext.Provider
      value={{
        rewardName,
        setRewardName,
        isLoading,
        error,
        retry: loadRewardName,
      }}
    >
      {children}
    </RewardNameContext.Provider>
  );
};
