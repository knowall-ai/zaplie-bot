import { useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { DefaultButton } from '@fluentui/react';
import * as microsoftTeams from '@microsoft/teams-js';
import { InteractionStatus } from '@azure/msal-browser';
import { loginRequest } from '../services/authConfig';

export const SignInButton = () => {
  const { instance, inProgress } = useMsal();
  const [error, setError] = useState<string | null>(null);
  // Teams runs its own popup, so MSAL's inProgress stays None in the host
  // window. Without this the button stays live and a second click opens a
  // second popup.
  const [teamsSignInPending, setTeamsSignInPending] = useState(false);
  const busy = inProgress !== InteractionStatus.None || teamsSignInPending;

  const handleLogin = async () => {
    setError(null);
    if (busy) {
      setError('Sign-in is already in progress.');
      return;
    }

    const redirectUrl = window.location.href;
    const isInTeams =
      window.name === 'embedded-page-container' ||
      window.navigator.userAgent.includes('Teams/') ||
      new URLSearchParams(window.location.search).has('inTeams');

    if (isInTeams) {
      setTeamsSignInPending(true);
      try {
        await microsoftTeams.app.initialize();
        await microsoftTeams.app.getContext();
        const authUrl = new URL('/auth-start', window.location.origin);
        authUrl.searchParams.set('teamsAuth', '1');
        authUrl.searchParams.set('redirectUrl', redirectUrl);

        await microsoftTeams.authentication.authenticate({
          url: authUrl.href,
          width: 600,
          height: 535,
        });

        // AuthEnd set the active account before notifying Teams. The MSAL
        // cache is localStorage, so several accounts can be cached: only fall
        // back when there is exactly one and the choice is unambiguous.
        const accounts = instance.getAllAccounts();
        const account =
          instance.getActiveAccount() ??
          (accounts.length === 1 ? accounts[0] : null);
        if (!account) {
          throw new Error('No authenticated account is available.');
        }

        instance.setActiveAccount(account);
        await instance.acquireTokenSilent({
          ...loginRequest,
          account,
        });
      } catch {
        setError('We could not sign you in. Please try again.');
      } finally {
        setTeamsSignInPending(false);
      }
      return;
    }

    try {
      await instance.loginRedirect({
        ...loginRequest,
        prompt: 'select_account',
      });
    } catch {
      setError('We could not sign you in. Please try again.');
    }
  };

  return (
    <div>
      <DefaultButton
        text={busy ? 'Signing In...' : 'Sign In'}
        onClick={handleLogin}
        disabled={busy}
        styles={{
          root: {
            color: 'black',
            width: 'auto',
            lineHeight: '20px',
            fontWeight: 600,
          },
        }}
      />
      {error && <p role="alert">{error}</p>}
    </div>
  );
};
