import { ReactElement, useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../services/authConfig';
import { useNavigate } from 'react-router-dom';
import { ensureCurrentUser } from '../services/lnbits/users';
import { logger } from '../utils/logger';

// One provisioning call per signed-in account per page load, shared by every
// guarded route. It settles whether or not it succeeds: a gateway that is
// down must not keep the app blank, the pages then report their own errors as
// they always did. A failed call is forgotten, so the next guarded mount
// tries again once the gateway is back; a different account (sign out, sign
// in, no reload) gets its own call.
let callerReady: { account: string; promise: Promise<void> } | null = null;

const ensureCallerFor = (account: string): Promise<void> => {
  if (!callerReady || callerReady.account !== account) {
    const promise: Promise<void> = ensureCurrentUser()
      .then(() => undefined)
      .catch(error => {
        logger.error('Could not set up the signed-in user', error);
        if (callerReady?.promise === promise) {
          callerReady = null;
        }
      });
    callerReady = { account, promise };
  }
  return callerReady.promise;
};

// Exported for tests, so each one starts from a page that has not provisioned.
export const resetCallerReadyForTests = () => {
  callerReady = null;
};

const RequireAuth = ({ children }: { children: ReactElement }) => {
  const { instance, accounts, inProgress } = useMsal();
  const navigate = useNavigate();
  const [readyFor, setReadyFor] = useState<string | null>(null);
  // MSAL's homeAccountId is stable across tokens; localAccountId is the oid.
  const account = accounts[0];
  const accountKey = account
    ? account.homeAccountId || account.localAccountId || ''
    : '';

  useEffect(() => {
    if (accounts.length === 0 && inProgress === 'none') {
      instance.acquireTokenSilent(loginRequest).catch(() => {
        navigate('/login', { replace: true });
      });
    }
  }, [accounts, instance, inProgress, navigate]);

  useEffect(() => {
    if (!accountKey) {
      return;
    }
    let active = true;
    void ensureCallerFor(accountKey).then(() => {
      if (active) {
        setReadyFor(accountKey);
      }
    });
    return () => {
      active = false;
    };
  }, [accountKey]);

  // Readiness belongs to one account: another person's sign-in waits for
  // their own provisioning before any page renders.
  return accountKey !== '' && readyFor === accountKey ? children : null;
};

export default RequireAuth;
