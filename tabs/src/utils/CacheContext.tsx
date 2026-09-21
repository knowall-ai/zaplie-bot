import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  ReactNode,
} from 'react';

interface CacheContextType {
  cache: Record<string, any>;
  setCache: (key: string, value: any) => void;
}

const CacheContext = createContext<CacheContextType | undefined>(undefined);

export const CacheProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [cache, setCacheState] = useState<Record<string, any>>({});

  // Memoised: consumers list `setCache` in effect dependencies, and an effect
  // that also writes to the cache would otherwise re-run on every provider
  // render — an unbounded fetch loop (Feed.tsx does exactly this).
  const setCache = useCallback((key: string, value: any) => {
    setCacheState(prevCache => ({ ...prevCache, [key]: value }));
  }, []);

  const value = useMemo(() => ({ cache, setCache }), [cache, setCache]);

  return (
    <CacheContext.Provider value={value}>{children}</CacheContext.Provider>
  );
};

export const useCache = (): CacheContextType => {
  const context = useContext(CacheContext);
  if (!context) {
    throw new Error('useCache must be used within a CacheProvider');
  }
  return context;
};
