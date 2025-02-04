import React, { useEffect } from 'react';
import { PublicClientApplication } from '@azure/msal-browser';
import { msalConfig } from './services/authConfig';

const AuthEnd: React.FC = () => {
  useEffect(() => {
    const msalInstance = new PublicClientApplication(msalConfig);
    const urlParams = new URLSearchParams(window.location.search);
    const redirectUrl = urlParams.get('redirectUrl') || window.location.origin;
    msalInstance.initialize().then(() => {
      msalInstance
        .handleRedirectPromise()
        .then(response => {
          window.close();
          if (response) {
            // Authentication was successful
            window.opener.postMessage(
              {
                type: 'auth-success',
                data: response,
              },
              window.location.origin,
            );
            if (window.opener) {
              window.opener.focus();
              window.close(); // Close the authentication window
              if (!window.closed) {
                window.location.href = redirectUrl; // Fallback to redirect if window.close() fails
              }
            } else {
              window.location.href = redirectUrl; // Redirect to the original page
            }
          }
        })
        .catch(error => {
          console.error('Error handling redirect:', error);
          window.opener.postMessage(
            {
              type: 'auth-error',
              data: error,
            },
            window.location.origin,
          );
          window.opener.focus();
          window.close(); // Close the authentication window
          if (!window.closed) {
            window.location.href = redirectUrl; // Fallback to redirect if window.close() fails
          }
        });
    }).catch(error => {
      console.error('Error initializing MSAL:', error);
    });
  }, []);

  return (
    <div>
      <h1>Completing Authentication...</h1>
    </div>
  );
};

export default AuthEnd;