import React, { useEffect, useState } from 'react';
import { InteractionStatus } from '@azure/msal-browser';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from './services/authConfig';
import { appUrl } from './services/appLocation';
import {
  AUTH_FLOW_STORAGE_KEY,
  notifyTeams,
  resolveSameOriginRedirect,
} from './AuthEnd';

interface StoredAuthFlow {
  redirectUrl: string;
  teamsAuth: boolean;
}

const AuthStart: React.FC = () => {
  const { instance, inProgress } = useMsal();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (
      inProgress === InteractionStatus.Startup ||
      inProgress === InteractionStatus.HandleRedirect
    ) {
      return;
    }

    let active = true;

    const startAuthentication = async () => {
      const params = new URLSearchParams(window.location.search);
      const flow: StoredAuthFlow = {
        redirectUrl: resolveSameOriginRedirect(params.get('redirectUrl')),
        teamsAuth: params.get('teamsAuth') === '1',
      };

      try {
        try {
          sessionStorage.setItem(AUTH_FLOW_STORAGE_KEY, JSON.stringify(flow));
        } catch {
          // AuthEnd safely returns to the app origin when storage is unavailable.
        }

        const accounts = instance.getAllAccounts();
        if (accounts.length > 0) {
          if (!instance.getActiveAccount()) {
            instance.setActiveAccount(accounts[0]);
          }
          window.location.assign(appUrl('/auth-end'));
          return;
        }

        if (inProgress !== InteractionStatus.None) {
          return;
        }

        await instance.loginRedirect({
          ...loginRequest,
          redirectUri: appUrl('/auth-end'),
        });
      } catch {
        // TeamsJS leaves the host promise pending until the popup notifies,
        // so without this the Sign In button stays disabled until the window
        // is closed by hand.
        if (flow.teamsAuth && (await notifyTeams('auth-error'))) {
          return;
        }
        if (active) {
          setError(
            'We could not start sign-in. Close this window and try again.',
          );
        }
      }
    };

    void startAuthentication();
    return () => {
      active = false;
    };
  }, [inProgress, instance]);

  return (
    <main>
      <h1>Starting authentication...</h1>
      {error && <p role="alert">{error}</p>}
    </main>
  );
};

export default AuthStart;
