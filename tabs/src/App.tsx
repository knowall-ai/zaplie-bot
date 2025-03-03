import { BrowserRouter as Router, Route, Routes, Navigate, useLocation  } from 'react-router-dom';
import { useEffect } from 'react';
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
import AuthStart from './AuthStart';
import AuthEnd from './AuthEnd';


type AppProps = {
  pca: IPublicClientApplication;
};

// Function to update the title based on the current route
function TitleUpdater() {
  const location = useLocation();

  useEffect(() => {
    const titles: { [key: string]: string } = {
      "/feed": "Feed - Zapp.ie",
      "/users": "Users - Zapp.ie",
      "/rewards": "Rewards - Zapp.ie",
      "/wallet": "Wallet - Zapp.ie",
      "/login": "Login - Zapp.ie",
      "/auth-start": "Authenticating...",
      "/auth-end": "Authentication Complete",
    };

    document.title = titles[location.pathname] || "Zapp.ie"; 
  }, [location]);

  return null;
}



function App({ pca }: AppProps) {
  return (
    <MsalProvider instance={pca}> 
    <TitleUpdater />
     <PageLayout> 
     <Stack horizontalAlign="center">    
        <Routes>
          <Route path="/feed" element={<RequireAuth><Feed /></RequireAuth>} />
          <Route path="/users" element={<RequireAuth><Users /></RequireAuth>} />
          <Route path="/rewards" element={<RequireAuth><Rewards /></RequireAuth>} />
          <Route path="/wallet" element={<RequireAuth><Wallet /></RequireAuth>} />
          <Route path="/login" element={<Login />} />
          <Route path="/auth-start" element={<AuthStart />} />
          <Route path="/auth-end" element={<AuthEnd />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />         
        </Routes>
      </Stack>
      </PageLayout>
     </MsalProvider>
  );
}

export default App;
