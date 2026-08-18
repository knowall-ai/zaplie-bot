import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  EventType,
  EventMessage,
  AuthenticationResult,
} from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { BrowserRouter as Router } from 'react-router-dom';
import { ThemeProvider } from '@fluentui/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { theme } from './styles/Theme';
import App from './App';
import { msalInstance } from './services/msalClient';
import { CacheProvider } from './utils/CacheContext';
import { queryClient } from './query/queryClient';

const container = document.getElementById('root');

if (!container) {
  throw new Error('The application root element is missing.');
}

const root = ReactDOM.createRoot(container);

const renderApp = () => {
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

const renderStartupError = () => {
  root.render(
    <main role="alert">
      <h1>Zaplie could not start</h1>
      <p>Reload the page to try signing in again.</p>
      <button type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </main>,
  );
};

const initializeApp = async () => {
  try {
    await msalInstance.initialize();
    const response = await msalInstance.handleRedirectPromise();
    if (response) {
      msalInstance.setActiveAccount(response.account);
    } else {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        msalInstance.setActiveAccount(accounts[0]);
      }
    }

    msalInstance.addEventCallback((event: EventMessage) => {
      if (event.eventType === EventType.LOGIN_SUCCESS && event.payload) {
        const payload = event.payload as AuthenticationResult;
        msalInstance.setActiveAccount(payload.account);
      }
    });

    renderApp();
  } catch {
    renderStartupError();
  }
};

void initializeApp();
