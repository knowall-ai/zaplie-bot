import { Route, Routes, Navigate, useLocation  } from 'react-router-dom';
import { useEffect } from 'react';
// Fluent UI imports
import { Stack } from '@fluentui/react';

// MSAL imports
import { MsalProvider } from '@azure/msal-react';
import { IPublicClientApplication } from '@azure/msal-browser';
import RequireAuth from './components/RequireAuth';

// Sample app imports
import { PageLayout } from './components/PageLayout';
import { RewardNameProvider } from './components/RewardNameContext';


// Import the pages
import Login from './Login';
import Feed from './Feed';
import Users from './Users';
import './App.css';
import Rewards from './Rewards';
import Wallet from './Wallet';
import AuthStart from './AuthStart';
import AuthEnd from './AuthEnd';
import Settings from './Settings';


type AppProps = {
  pca: IPublicClientApplication;
};

// Function to update the title based on the current route
function TitleUpdater() {
  const location = useLocation();

  useEffect(() => {
    const titles: { [key: string]: string } = {
      "/feed": "Feed - Zaplie",
      "/users": "Users - Zaplie",
      "/rewards": "Rewards - Zaplie",
      "/wallet": "Wallet - Zaplie",
      "/login": "Login - Zaplie",
      "/auth-start": "Authenticating...",
      "/auth-end": "Authentication Complete",
      "/settings": "Settings - Zaplie",

    };

    document.title = titles[location.pathname] || "Zaplie"; 
  }, [location]);

  return null;
}



function App({ pca }: AppProps) {
  return (
    <MsalProvider instance={pca}> 

    <RewardNameProvider>
    <TitleUpdater />
     <PageLayout> 
     <Stack horizontalAlign="center">    
        <Routes>
          <Route path="/feed" element={<RequireAuth><Feed /></RequireAuth>} />
          <Route path="/users" element={<RequireAuth><Users /></RequireAuth>} />
          <Route path="/rewards" element={<RequireAuth><Rewards /></RequireAuth>} />
          <Route path="/wallet" element={<RequireAuth><Wallet /></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
          <Route path="/login" element={<Login />} />
          <Route path="/auth-start" element={<AuthStart />} />
          <Route path="/auth-end" element={<AuthEnd />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />         
        </Routes>
      </Stack>
      </PageLayout>
      </RewardNameProvider>
     </MsalProvider>
  );
}

export default App;
