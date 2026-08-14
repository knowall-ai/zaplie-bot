import { useState, useCallback, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { clearApiCache } from '../services/lnbitsServiceLocal';
import { teamsContextQueryOptions } from '../services/teamsContextService';

interface UseTeamsAuthReturn {
  isInTeams: boolean;
  isTeamsInitializing: boolean;
  handleLogout: () => Promise<void>;
  isLoggingOut: boolean;
}

/**
 * Custom hook for Teams SDK initialization and authentication.
 * Centralizes Teams context detection and logout logic to avoid duplication.
 */
export const useTeamsAuth = (): UseTeamsAuthReturn => {
  const { instance, accounts, inProgress } = useMsal();
  const { data: isInTeams = false, isPending: isTeamsInitializing } = useQuery(
    teamsContextQueryOptions,
  );
  const [isLoggingOut, setIsLoggingOut] = useState<boolean>(false);

  // Ref to prevent race conditions in concurrent React mode
  const logoutInProgressRef = useRef<boolean>(false);

  const handleLogout = useCallback(async () => {
    // Check if MSAL has an interaction in progress
    if (inProgress !== InteractionStatus.None) {
      return;
    }

    // Use ref to prevent race conditions in concurrent React mode
    if (logoutInProgressRef.current) return;
    logoutInProgressRef.current = true;
    setIsLoggingOut(true);

    try {
      // Clear API cache before logout to prevent stale data on re-login
      clearApiCache();

      await instance.logoutPopup({
        postLogoutRedirectUri: window.location.origin + '/login',
        account: accounts[0] || null,
      });
    } catch (error) {
      toast.error('Failed to sign out. Please try again.');
    } finally {
      logoutInProgressRef.current = false;
      setIsLoggingOut(false);
    }
  }, [instance, accounts, inProgress]);

  return {
    isInTeams,
    isTeamsInitializing,
    handleLogout,
    isLoggingOut,
  };
};

export default useTeamsAuth;
