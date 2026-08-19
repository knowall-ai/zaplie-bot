import React, { useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import * as microsoftTeams from '@microsoft/teams-js';

export const AUTH_FLOW_STORAGE_KEY = 'zaplie.auth.flow';

type AuthSignal = 'auth-success' | 'auth-error';

interface StoredAuthFlow {
  redirectUrl?: unknown;
  teamsAuth?: unknown;
}

interface AuthFlow {
  redirectUrl: string;
  teamsAuth: boolean;
}

export const resolveSameOriginRedirect = (
  value: string | null,
  origin = window.location.origin,
): string => {
  if (!value) {
    return origin;
  }

  try {
    const target = new URL(value, origin);
    return target.origin === origin ? target.href : origin;
  } catch {
    return origin;
  }
};

export const postAuthSignal = (
  opener: Window | null,
  signal: AuthSignal,
  origin = window.location.origin,
): boolean => {
  if (!opener || opener.closed) {
    return false;
  }

  try {
    opener.postMessage({ type: signal }, origin);
    opener.focus();
    return true;
  } catch {
    return false;
  }
};

const readAuthFlow = (): AuthFlow => {
  const params = new URLSearchParams(window.location.search);
  let stored: StoredAuthFlow = {};

  try {
    const serialized = sessionStorage.getItem(AUTH_FLOW_STORAGE_KEY);
    // Cleared before parsing so a corrupted entry cannot outlive this read.
    sessionStorage.removeItem(AUTH_FLOW_STORAGE_KEY);
    if (serialized) {
      stored = JSON.parse(serialized) as StoredAuthFlow;
    }
  } catch {
    stored = {};
  }

  const storedRedirect =
    typeof stored.redirectUrl === 'string' ? stored.redirectUrl : null;

  return {
    redirectUrl: resolveSameOriginRedirect(
      storedRedirect ?? params.get('redirectUrl'),
    ),
    teamsAuth: stored.teamsAuth === true || params.get('teamsAuth') === '1',
  };
};

const notifyTeams = async (signal: AuthSignal): Promise<boolean> => {
  try {
    await microsoftTeams.app.initialize();
    if (signal === 'auth-success') {
      microsoftTeams.authentication.notifySuccess(signal);
    } else {
      microsoftTeams.authentication.notifyFailure(signal);
    }
    return true;
  } catch {
    return false;
  }
};

const AuthEnd: React.FC = () => {
  const { instance } = useMsal();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const flow = readAuthFlow();

    const completeAuthentication = async () => {
      try {
        const response = await instance.handleRedirectPromise();
        const account =
          response?.account ??
          instance.getActiveAccount() ??
          instance.getAllAccounts()[0];

        if (!account) {
          throw new Error('No authenticated account is available.');
        }

        instance.setActiveAccount(account);
        postAuthSignal(window.opener, 'auth-success');

        if (flow.teamsAuth && (await notifyTeams('auth-success'))) {
          return;
        }

        if (window.opener && !window.opener.closed) {
          window.close();
          if (window.closed) {
            return;
          }
        }

        window.location.assign(flow.redirectUrl);
      } catch {
        postAuthSignal(window.opener, 'auth-error');
        if (flow.teamsAuth && (await notifyTeams('auth-error'))) {
          return;
        }
        if (active) {
          setError(
            'We could not complete sign-in. Close this window and try again.',
          );
        }
      }
    };

    void completeAuthentication();
    return () => {
      active = false;
    };
  }, [instance]);

  return (
    <main>
      <h1>Completing authentication...</h1>
      {error && <p role="alert">{error}</p>}
    </main>
  );
};

export default AuthEnd;
