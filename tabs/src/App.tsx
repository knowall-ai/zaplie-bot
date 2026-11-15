import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ReactElement, useEffect } from 'react';
import { Stack } from '@fluentui/react';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

import { MsalProvider } from '@azure/msal-react';
import { IPublicClientApplication } from '@azure/msal-browser';
import RequireAuth from './components/RequireAuth';

import { PageLayout } from './components/PageLayout';
import { RewardNameProvider } from './components/RewardNameContext';

import Login from './Login';
import Feed from './Feed';
import Users from './Users';
import './App.css';
import Rewards from './Rewards';
import Automations from './Automations';
import Reports from './Reports';
import Wallet from './Wallet';
import AuthStart from './AuthStart';
import AuthEnd from './AuthEnd';
import Settings from './Settings';
import TenantSetup from './TenantSetup';
import ErrorBoundary from './components/ErrorBoundary';
import { NotFound } from './components/StatusPage';

type AppProps = {
  pca: IPublicClientApplication;
};

function TitleUpdater() {
  const location = useLocation();

  useEffect(() => {
    const titles: { [key: string]: string } = {
      '/feed': 'Feed - Zaplie',
      '/users': 'Users - Zaplie',
      '/rewards': 'Rewards - Zaplie',
      '/wallet': 'Wallet - Zaplie',
      '/login': 'Login - Zaplie',
      '/auth-start': 'Authenticating...',
      '/auth-end': 'Authentication Complete',
      '/settings': 'Settings - Zaplie',
      '/setup': 'Set up your organisation - Zaplie',
    };

    document.title = titles[location.pathname] || 'Zaplie';
  }, [location]);

  return null;
}

// The root still opens the Feed; any other unknown address shows Not found
// instead of silently landing on the Feed.
function RedirectToFeed() {
  return <Navigate to="/feed" replace />;
}

// One boundary per route, reset when the address changes, so a broken page
// does not take the navigation down with it.
function RouteBoundary({ children }: { children: ReactElement }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}

function App({ pca }: AppProps) {
  return (
    <ErrorBoundary>
      <MsalProvider instance={pca}>
        <RewardNameProvider>
          <TitleUpdater />
          <ToastContainer
            position="top-right"
            autoClose={5000}
            hideProgressBar={false}
            newestOnTop
            closeOnClick
            rtl={false}
            pauseOnFocusLoss
            draggable
            pauseOnHover
            theme="dark"
          />
          <PageLayout>
            <Stack styles={{ root: { width: '100%', minWidth: 0 } }}>
              <RouteBoundary>
                <Routes>
                  <Route
                    path="/feed"
                    element={
                      <RequireAuth>
                        <Feed />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/users"
                    element={
                      <RequireAuth>
                        <Users />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/rewards"
                    element={
                      <RequireAuth>
                        <Rewards />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/automations"
                    element={
                      <RequireAuth>
                        <Automations />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/reports"
                    element={
                      <RequireAuth>
                        <Reports />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/wallet"
                    element={
                      <RequireAuth>
                        <Wallet />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/settings"
                    element={
                      <RequireAuth>
                        <Settings />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/setup"
                    element={
                      <RequireAuth>
                        <TenantSetup />
                      </RequireAuth>
                    }
                  />
                  <Route path="/login" element={<Login />} />
                  <Route path="/auth-start" element={<AuthStart />} />
                  <Route path="/auth-end" element={<AuthEnd />} />
                  <Route path="/" element={<RedirectToFeed />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </RouteBoundary>
            </Stack>
          </PageLayout>
        </RewardNameProvider>
      </MsalProvider>
    </ErrorBoundary>
  );
}

export default App;
