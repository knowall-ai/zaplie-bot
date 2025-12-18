import { useEffect, useState, useCallback, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import * as microsoftTeams from '@microsoft/teams-js';
import { toast } from 'react-toastify';
import { clearApiCache } from '../services/lnbitsServiceLocal';

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
  const [isInTeams, setIsInTeams] = useState<boolean>(false);
  const [isTeamsInitializing, setIsTeamsInitializing] = useState<boolean>(true);
  const [isLoggingOut, setIsLoggingOut] = useState<boolean>(false);

  // Ref to prevent race conditions in concurrent React mode
  const logoutInProgressRef = useRef<boolean>(false);

  // Initialize Teams SDK and detect if running in Teams
  useEffect(() => {
    let mounted = true;

    const initializeTeams = async () => {
      try {
        await microsoftTeams.app.initialize();
        const context = await microsoftTeams.app.getContext();
        if (context && mounted) {
          setIsInTeams(true);
        }
      } catch {
        // Not running in Teams context - this is expected for web browser
        if (mounted) {
          setIsInTeams(false);
        }
      } finally {
        if (mounted) {
          setIsTeamsInitializing(false);
        }
      }
    };

    initializeTeams();

    return () => {
      mounted = false;
    };
  }, []);

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
