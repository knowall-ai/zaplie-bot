import { Routes, Route, useNavigate } from 'react-router-dom';
// Fluent UI imports
import { Stack } from '@fluentui/react';

// MSAL imports
import { MsalProvider } from '@azure/msal-react';
import { IPublicClientApplication } from '@azure/msal-browser';
import { CustomNavigationClient } from './utils/NavigationClient';
import RequireAuth from './components/RequireAuth';

// Sample app imports
import { PageLayout } from './components/PageLayout';

// Import the pages
import Login from './Login';
import Feed from './Feed';
import Users from './Users';
import './App.css';
import Rewards from './Rewards';
import Wallet from './Wallet';

type AppProps = {
  pca: IPublicClientApplication;
};

function App({ pca }: AppProps) {
  // The next 3 lines are optional. This is how you configure MSAL to take advantage of the router's navigate functions when MSAL redirects between pages in your app
  const navigate = useNavigate();
  const navigationClient = new CustomNavigationClient(navigate);
  pca.setNavigationClient(navigationClient);

  return (
    <MsalProvider instance={pca}>
      <PageLayout>
        <Stack horizontalAlign="center">
          <Pages />
        </Stack>
      </PageLayout>
    </MsalProvider>
  );
}

function Pages() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
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
        path="/Rewards"
        element={
          <RequireAuth>
            <Rewards />
          </RequireAuth>
        }
      />
      <Route
        path="/Wallet"
        element={
          <RequireAuth>
            <Wallet />
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export default App;
