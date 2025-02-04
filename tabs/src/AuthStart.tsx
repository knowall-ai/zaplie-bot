import React, { useEffect } from 'react';
import { PublicClientApplication, InteractionStatus } from '@azure/msal-browser';
import { useMsal } from '@azure/msal-react';
import { msalConfig } from './services/authConfig';

const AuthStart: React.FC = () => {
  const { inProgress } = useMsal();

  useEffect(() => {
    const msalInstance = new PublicClientApplication(msalConfig);

    msalInstance.initialize().then(() => {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        // User is already signed in
        if (inProgress !== InteractionStatus.Startup && inProgress !== InteractionStatus.HandleRedirect) {
          window.location.href = window.location.origin + '/auth-end'; // Redirect to the auth-end page
        }
      } else {
        // Check if an interaction is already in progress
        if (inProgress !== InteractionStatus.None) {
          // Initiate login
          msalInstance.loginRedirect({
            scopes: ['User.Read'],
            redirectUri: window.location.origin + '/auth-end', // Redirect back to auth-end page
          }).catch(error => {
            console.error('Error during loginRedirect:', error);
          });
        } else {
          console.log('Interaction is already in progress.');
        }
      }
    }).catch(error => {
      console.error('Error initializing MSAL:', error);
    });
  }, [inProgress]);

  return (
    <div>
      <h1>Starting Authentication...</h1>
    </div>
  );
};

export default AuthStart;