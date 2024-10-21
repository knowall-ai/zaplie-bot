import React, { useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../services/authConfig';

const RequireAuth = ({ children }: { children: JSX.Element }) => {
  const { instance, accounts } = useMsal();

  useEffect(() => {
    if (accounts.length === 0) {
      instance.loginPopup(loginRequest).catch((error) => {
        console.error(error);
      });
    }
  }, [accounts, instance]);

  return accounts.length > 0 ? children : null;
};

export default RequireAuth;