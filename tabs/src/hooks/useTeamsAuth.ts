import { useState, useCallback, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { clearApiCache } from '../services/wallet/cache';
import { markSilentSignInAttempted } from '../services/silentSignIn';
import { teamsContextQueryOptions } from '../services/teamsContextService';
import { appUrl } from '../services/appLocation';

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
    // The redirect/popup choice needs the host; until Teams detection has
    // settled, isInTeams is only a default.
    if (isTeamsInitializing) {
      return;
    }
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
      // Signing out must not be undone by a silent sign-in on the sign-in
      // page, so this tab session counts as attempted (sessionStorage, so it
      // survives the sign-out redirect). MSAL resolves logoutPopup even when
      // the popup is blocked or closed early, so the Entra session may still
      // be alive. A fresh visit tries again.
      markSilentSignInAttempted();

      const request = {
        postLogoutRedirectUri: appUrl('/login'),
        account: accounts[0] || null,
      };
      if (isInTeams) {
        // The tab is an iframe that cannot redirect, so Teams signs out in a
        // popup. Its landing page relays the result and closes itself
        // (services/signOutPopup.ts, called from index.tsx).
        await instance.logoutPopup(request);
      } else {
        // A browser signs out in the same window and lands on the sign-in
        // page, where handleRedirectPromise ends the sign-out interaction.
        await instance.logoutRedirect(request);
      }
    } catch (error) {
      toast.error('Failed to sign out. Please try again.');
    } finally {
      logoutInProgressRef.current = false;
      setIsLoggingOut(false);
    }
  }, [instance, accounts, inProgress, isInTeams, isTeamsInitializing]);

  return {
    isInTeams,
    isTeamsInitializing,
    handleLogout,
    isLoggingOut,
  };
};

export default useTeamsAuth;
