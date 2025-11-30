import { useMsal } from '@azure/msal-react';
import * as microsoftTeams from '@microsoft/teams-js';
import React, { useEffect, useState } from 'react';

export const SignOutButton = () => {
  const { instance, accounts } = useMsal();
  const [isInTeams, setIsInTeams] = useState(false);

  // Initialize Teams SDK and detect if running in Teams
  useEffect(() => {
    microsoftTeams.app
      .initialize()
      .then(() => {
        microsoftTeams.app
          .getContext()
          .then(context => {
            setIsInTeams(true);
            console.log('Running inside Teams');
          })
          .catch(error => {
            console.error('Error getting Teams context:', error);
          });
      })
      .catch(error => {
        console.error('Error initializing Teams SDK:', error);
      });
  }, []);

  const handleLogout = async () => {
    try {
      // If inside Teams, handle MSAL logout and clear session
      if (isInTeams) {
        console.log('Logging out from Teams');

        // MSAL logout within Teams
        await instance.logoutPopup({
          postLogoutRedirectUri: window.location.origin + '/login',
          account: accounts[0] || null,
        });

        console.log('Successfully logged out from MSAL in Teams');

        // Optionally clear Teams-specific data here if required
      } else {
        console.log('Logging out from Web Browser');

        // MSAL logout in a web browser context
        await instance.logoutPopup({
          postLogoutRedirectUri: window.location.origin + '/login',
          account: accounts[0] || null,
        });

        console.log('Successfully logged out from MSAL in Web Browser');
      }
    } catch (error) {
      console.error('Error during logout:', error);
    }
  };


  return (
    <a
      href="#"
      onClick={e => {
        e.preventDefault();
        handleLogout();
      }}
      style={{
        textDecoration: 'none',
        cursor: 'pointer',
      }}
      onMouseEnter={e => {
        (e.target as HTMLElement).style.textDecoration = 'underline';
      }}
      onMouseLeave={e => {
        (e.target as HTMLElement).style.textDecoration = 'none';
      }}
      title="Sign Out"
      aria-label="Sign Out"
    >
      Sign Out
    </a>
  );

};

export default SignOutButton;