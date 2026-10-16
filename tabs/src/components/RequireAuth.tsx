import { ReactElement, useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../services/authConfig';
import { useNavigate } from 'react-router-dom';
import { ensureCurrentUser } from '../services/lnbits/users';
import { logger } from '../utils/logger';

// One provisioning call per page load, shared by every guarded route. It
// settles whether or not it succeeds: a gateway that is down must not keep
// the app blank, the pages then report their own errors as they always did.
let callerReady: Promise<void> | null = null;

const ensureCallerOnce = (): Promise<void> => {
  if (!callerReady) {
    callerReady = ensureCurrentUser()
      .then(() => undefined)
      .catch(error => {
        logger.error('Could not set up the signed-in user', error);
      });
  }
  return callerReady;
};

// Exported for tests, so each one starts from a page that has not provisioned.
export const resetCallerReadyForTests = () => {
  callerReady = null;
};

const RequireAuth = ({ children }: { children: ReactElement }) => {
  const { instance, accounts, inProgress } = useMsal();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (accounts.length === 0 && inProgress === 'none') {
      instance.acquireTokenSilent(loginRequest).catch(() => {
        navigate('/login', { replace: true });
      });
    }
  }, [accounts, instance, inProgress, navigate]);

  useEffect(() => {
    if (accounts.length === 0) {
      return;
    }
    let active = true;
    void ensureCallerOnce().then(() => {
      if (active) {
        setReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [accounts]);

  return accounts.length > 0 && ready ? children : null;
};

export default RequireAuth;
