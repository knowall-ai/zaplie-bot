import { useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../services/authConfig';
import { useNavigate } from 'react-router-dom';

const RequireAuth = ({ children }: { children: JSX.Element }) => {
  const { instance, accounts, inProgress } = useMsal();
  const navigate = useNavigate();

  useEffect(() => {
    if (accounts.length === 0 && inProgress === "none") {
      instance.acquireTokenSilent(loginRequest).catch(() => {
        navigate('/login', { replace: true });
      });
    }
  }, [accounts, instance, inProgress, navigate]);

  return accounts.length > 0 ? children : null;
};

export default RequireAuth;