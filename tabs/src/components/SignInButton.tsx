import { useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { DefaultButton } from '@fluentui/react';
import * as microsoftTeams from '@microsoft/teams-js';
import { InteractionStatus } from '@azure/msal-browser';
import { loginRequest } from '../services/authConfig';

export const SignInButton = () => {
  const { instance, inProgress } = useMsal();
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    setError(null);
    if (inProgress !== InteractionStatus.None) {
      setError('Sign-in is already in progress.');
      return;
    }

    const redirectUrl = window.location.href;
    const isInTeams =
      window.name === 'embedded-page-container' ||
      window.navigator.userAgent.includes('Teams/') ||
      new URLSearchParams(window.location.search).has('inTeams');

    if (isInTeams) {
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

        const account = instance.getAllAccounts()[0];
        if (!account) {
          throw new Error('No authenticated account is available.');
        }

        instance.setActiveAccount(account);
        await instance.acquireTokenSilent({
          ...loginRequest,
          account,
        });
      } catch {
        try {
          await instance.loginPopup(loginRequest);
        } catch {
          setError('We could not sign you in. Please try again.');
        }
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
        text={
          inProgress !== InteractionStatus.None ? 'Signing In...' : 'Sign In'
        }
        onClick={handleLogin}
        disabled={inProgress !== InteractionStatus.None}
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
