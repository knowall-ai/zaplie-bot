import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/tokens.css';
import {
  EventType,
  EventMessage,
  AuthenticationResult,
  PublicClientApplication,
} from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { BrowserRouter as Router } from 'react-router-dom';
import { ThemeProvider } from '@fluentui/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { theme } from './styles/Theme';
import App from './App';
import { getMsalInstance } from './services/msalClient';
import { CacheProvider } from './utils/CacheContext';
import { queryClient } from './query/queryClient';

const container = document.getElementById('root');

if (!container) {
  throw new Error('The application root element is missing.');
}

const root = ReactDOM.createRoot(container);

const renderApp = (msalInstance: PublicClientApplication) => {
  root.render(
    <QueryClientProvider client={queryClient}>
      <MsalProvider instance={msalInstance}>
        <CacheProvider>
          <Router>
            <ThemeProvider theme={theme}>
              <App pca={msalInstance} />
            </ThemeProvider>
          </Router>
        </CacheProvider>
      </MsalProvider>
    </QueryClientProvider>,
  );
};

// The message only ever names missing configuration (never its value), so it
// is safe to show: without it a misconfigured deployment is a blank error.
const renderStartupError = (error: unknown) => {
  const detail = error instanceof Error ? error.message : null;

  root.render(
    <main role="alert">
      <h1>Zaplie could not start</h1>
      {detail && <p>{detail}</p>}
      <p>Reload the page to try signing in again.</p>
      <button type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </main>,
  );
};

export const initializeApp = async () => {
  let msalInstance: PublicClientApplication;

  // Only a broken MSAL instance is fatal: without one there is no app to show.
  try {
    msalInstance = getMsalInstance();
    await msalInstance.initialize();
  } catch (error) {
    console.error('Zaplie startup failed', error);
    renderStartupError(error);
    return;
  }

  // A rejected redirect is not fatal. Declining consent lands on
  // /auth-end?error=access_denied, and AuthEnd still has to mount so it can
  // call notifyFailure -- replacing the SPA with a startup error would leave
  // the Teams authentication popup hanging until it is closed by hand.
  try {
    const response = await msalInstance.handleRedirectPromise();
    if (response) {
      msalInstance.setActiveAccount(response.account);
    } else if (!msalInstance.getActiveAccount()) {
      // Only pick a default when nothing is active yet: several accounts can
      // be cached in localStorage, and overwriting the chosen one would let
      // the LNbits gateway acquire a token for the wrong identity.
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        msalInstance.setActiveAccount(accounts[0]);
      }
    }
  } catch (error) {
    console.error('Zaplie could not complete the sign-in redirect', error);
  }

  msalInstance.addEventCallback((event: EventMessage) => {
    if (event.eventType === EventType.LOGIN_SUCCESS && event.payload) {
      const payload = event.payload as AuthenticationResult;
      msalInstance.setActiveAccount(payload.account);
    }
  });

  renderApp(msalInstance);
};

// Exported so the startup sequence can be awaited in tests.
export const startupComplete = initializeApp();
