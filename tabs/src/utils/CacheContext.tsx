import React, {
  createContext,
  useCallback,
  useContext,
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

  const setCache = useCallback(
    (key: string, value: any) => {
      setCacheState(prevCache => ({ ...prevCache, [key]: value }));
    },
    [setCacheState],
  );

  return (
    <CacheContext.Provider value={{ cache, setCache }}>
      {children}
    </CacheContext.Provider>
  );
};

export const useCache = (): CacheContextType => {
  const context = useContext(CacheContext);
  if (!context) {
    throw new Error('useCache must be used within a CacheProvider');
  }
  return context;
};
