import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  ReactNode,
} from 'react';

interface CacheContextType {
  cache: Record<string, unknown>;
  setCache: (key: string, value: unknown) => void;
}

const CacheContext = createContext<CacheContextType | undefined>(undefined);

export const CacheProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [cache, setCacheState] = useState<Record<string, unknown>>({});

  const setCache = useCallback((key: string, value: unknown) => {
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
