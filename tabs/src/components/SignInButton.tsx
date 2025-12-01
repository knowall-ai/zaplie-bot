import { useMsal } from '@azure/msal-react';
import { DefaultButton } from '@fluentui/react';
import * as microsoftTeams from '@microsoft/teams-js';
import { loginRequest } from '../services/authConfig';
import { InteractionStatus } from '@azure/msal-browser';

export const SignInButton = () => {
  const { instance, inProgress } = useMsal();

  const handleLogin = async () => {
    // Prevent login if an interaction is already in progress
    if (inProgress !== InteractionStatus.None) {
      console.log(`Authentication already in progress: ${inProgress}, please wait...`);
      return;
    }

    // Check if there's a stale interaction flag in storage and clear it
    const interactionKey = 'msal.interaction.status';
    try {
      const storedStatus = sessionStorage.getItem(interactionKey) || localStorage.getItem(interactionKey);
      if (storedStatus && storedStatus !== 'none') {
        console.log('Clearing stale interaction status:', storedStatus);
        sessionStorage.removeItem(interactionKey);
        localStorage.removeItem(interactionKey);
        // Wait a moment for MSAL to sync
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (e) {
      console.error('Error checking interaction status:', e);
    }

    const redirectUrl = window.location.href;

    // Check if running in Teams by looking at the URL or user agent
    const isInTeams = window.name === 'embedded-page-container' ||
                      window.navigator.userAgent.includes('Teams/') ||
                      new URLSearchParams(window.location.search).has('inTeams');

    if (isInTeams) {
      console.log('Detected Teams environment');

      try {
        // Initialize Teams SDK and check context
        await microsoftTeams.app.initialize();
        await microsoftTeams.app.getContext();

        console.log('Running inside Teams');

        // Use the new `authentication.authenticate` method
        try {
          const authToken = await microsoftTeams.authentication.authenticate({
            url: `${window.location.origin}/auth-start?action=login&redirectUrl=${encodeURIComponent(redirectUrl)}`,
            width: 600,
            height: 535,
          });

          console.log('Teams Auth Token:', authToken);

          const accounts = instance.getAllAccounts();
          if (accounts.length === 0) {
            console.warn('No accounts found for silent token acquisition');
            return;
          }

          const msalResponse = await instance.acquireTokenSilent({
            scopes: ['User.Read'],
            account: accounts[0],
          });

          console.log('MSAL Token Response:', msalResponse);
        } catch (error) {
          console.error('Error during Teams authentication:', error);

          // Fallback to interactive login
          try {
            const msalResponse = await instance.loginPopup(loginRequest);
            console.log('MSAL Token Response (interactive):', msalResponse);
          } catch (interactiveError) {
            console.error('Error during interactive login:', interactiveError);
          }
        }
      } catch (error) {
        console.error('Teams SDK initialization error:', error);
      }
    } else {
      // Running in a web browser - use redirect instead of popup
      console.log('Running in a web browser - using redirect flow');

      try {
        await instance.loginRedirect({
          scopes: ['User.Read'],
          prompt: 'select_account',
        });
      } catch (error) {
        console.error('Error during loginRedirect:', error);
      }
    }
  };

  return (
    <div>
      <DefaultButton
        text={inProgress !== InteractionStatus.None ? "Signing In..." : "Sign In"}
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
    </div>
  );
};