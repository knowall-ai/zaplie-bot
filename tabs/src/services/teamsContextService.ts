import { queryOptions } from '@tanstack/react-query';
import * as microsoftTeams from '@microsoft/teams-js';

export const teamsContextQueryKey = ['host', 'teams'] as const;

export const detectTeamsContext = async (): Promise<boolean> => {
  try {
    if (!microsoftTeams.app.isInitialized()) {
      await microsoftTeams.app.initialize();
    }

    await microsoftTeams.app.getContext();
    return true;
  } catch {
    return false;
  }
};

export const teamsContextQueryOptions = queryOptions({
  queryKey: teamsContextQueryKey,
  queryFn: detectTeamsContext,
  staleTime: Infinity,
  gcTime: Infinity,
  retry: false,
  retryOnMount: false,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  networkMode: 'always',
});
