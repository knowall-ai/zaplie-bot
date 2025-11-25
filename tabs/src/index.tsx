import React from 'react';
import ReactDOM from 'react-dom/client';
import { PublicClientApplication, EventType, EventMessage, AuthenticationResult } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { BrowserRouter as Router } from 'react-router-dom';
import { ThemeProvider } from '@fluentui/react';
import { theme } from './styles/Theme'; // Adjust the import path as necessary
import App from './App'; // Adjust the import path as necessary
import { msalConfig } from './services/authConfig';
import { CacheProvider } from './utils/CacheContext';


export const msalInstance = new PublicClientApplication(msalConfig);

msalInstance.initialize().then(async () => {
  // Handle redirect promise BEFORE rendering the app
  try {
    const response = await msalInstance.handleRedirectPromise();
    if (response) {
      console.log('Login successful, setting active account');
      msalInstance.setActiveAccount(response.account);
    } else {
      // No redirect response, check for existing accounts
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        msalInstance.setActiveAccount(accounts[0]);
      }
    }
  } catch (error) {
    console.error('Error handling redirect:', error);
  }

  msalInstance.addEventCallback((event: EventMessage) => {
    if (event.eventType === EventType.LOGIN_SUCCESS && event.payload) {
      const payload = event.payload as AuthenticationResult;
      const account = payload.account;
      msalInstance.setActiveAccount(account);
    }
  });

  // Render app AFTER handling redirect
  const container = document.getElementById('root');
  const root = ReactDOM.createRoot(container!);
  root.render(
    <MsalProvider instance={msalInstance}>
      <CacheProvider>
      <Router>
        <ThemeProvider theme={theme}>
          <CacheProvider>
          <App pca={msalInstance} />
          </CacheProvider>
        </ThemeProvider>
      </Router>
    </CacheProvider>,
    </MsalProvider>

  );
});
