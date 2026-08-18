import React, {
  FunctionComponent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { useMsal } from '@azure/msal-react';
import connectionStyles from './connections.module.css';
import GithubIcon from '../images/GitHub.svg';
import CheckmarkIcon from '../images/CheckmarkCircleGreen.svg';
import { loginRequest } from '../services/authConfig';
import {
  getMyIdentities,
  getGithubAuthorizeUrl,
  LinkedIdentity,
} from '../services/identityService';
import { toast } from 'react-toastify';

const useGithubReturnStatus = () => {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('github');
    if (!status) {
      return;
    }
    if (status === 'connected') {
      toast.success('GitHub connected.');
    } else if (status === 'repos_connected') {
      toast.success('Repositories connected.');
    } else if (status === 'conflict') {
      toast.error('That GitHub account is already linked to another person.');
    } else if (status === 'install_error') {
      toast.error('Connecting repositories failed. Please try again.');
    } else {
      toast.error('Connecting GitHub failed. Please try again.');
    }
    params.delete('github');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
  }, []);
};

const ConnectionsSetting: FunctionComponent = () => {
  const { instance, accounts } = useMsal();
  const account = accounts[0];
  const [identities, setIdentities] = useState<LinkedIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useGithubReturnStatus();

  const loadIdentities = useCallback(async () => {
    setLoadError(false);
    if (!account) {
      setIdentities([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const tokenResponse = await instance.acquireTokenSilent({
        ...loginRequest,
        account,
        forceRefresh: true,
      });
      const mine = await getMyIdentities(tokenResponse.idToken);
      setIdentities(mine);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [account, instance]);

  useEffect(() => {
    void loadIdentities();
  }, [loadIdentities]);

  const handleConnect = async () => {
    if (!account) {
      return;
    }
    setConnecting(true);
    try {
      const tokenResponse = await instance.acquireTokenSilent({
        ...loginRequest,
        account,
        forceRefresh: true,
      });
      const authorizeUrl = await getGithubAuthorizeUrl(tokenResponse.idToken);
      window.location.href = authorizeUrl;
    } catch {
      toast.error('Could not start the GitHub connection.');
      setConnecting(false);
    }
  };

  const handleRetry = () => {
    void loadIdentities();
  };

  const githubIdentity = identities.find(
    identity => identity.provider === 'github',
  );

  return (
    <section
      className={connectionStyles.section}
      aria-labelledby="connections-heading"
    >
      <div className={connectionStyles.sectionHeader}>
        <div>
          <h2 id="connections-heading" className={connectionStyles.heading}>
            Connections
          </h2>
          <p className={connectionStyles.intro}>
            Link accounts so automated rewards reach the right Zaplie profile.
          </p>
        </div>
      </div>

      <div className={connectionStyles.card} aria-busy={loading}>
        <div className={connectionStyles.provider}>
          <span className={connectionStyles.iconFrame} aria-hidden="true">
            <img src={GithubIcon} alt="" className={connectionStyles.icon} />
          </span>

          <div className={connectionStyles.providerCopy}>
            <div className={connectionStyles.providerTitleRow}>
              <h3 className={connectionStyles.providerName}>GitHub</h3>
              {loading ? (
                <span
                  className={`${connectionStyles.badge} ${connectionStyles.badgeNeutral}`}
                >
                  Checking…
                </span>
              ) : loadError ? (
                <span
                  className={`${connectionStyles.badge} ${connectionStyles.badgeDanger}`}
                >
                  Unavailable
                </span>
              ) : githubIdentity ? (
                <span
                  className={`${connectionStyles.badge} ${connectionStyles.badgeConnected}`}
                >
                  <img
                    src={CheckmarkIcon}
                    alt=""
                    className={connectionStyles.badgeIcon}
                  />
                  Connected
                </span>
              ) : (
                <span
                  className={`${connectionStyles.badge} ${connectionStyles.badgeNeutral}`}
                >
                  Not connected
                </span>
              )}
            </div>
            {loading ? (
              <div className={connectionStyles.loadingLines} aria-hidden="true">
                <span className={connectionStyles.loadingLine} />
                <span
                  className={`${connectionStyles.loadingLine} ${connectionStyles.loadingLineShort}`}
                />
              </div>
            ) : loadError ? (
              <p className={connectionStyles.errorText} role="alert">
                We couldn't load this connection. Try again.
              </p>
            ) : githubIdentity ? (
              <p
                className={connectionStyles.accountHandle}
                title={`@${githubIdentity.providerHandle}`}
              >
                Connected as @{githubIdentity.providerHandle}
              </p>
            ) : (
              <p className={connectionStyles.providerDescription}>
                Connect GitHub to receive rewards from pull requests and other
                automations.
              </p>
            )}
            {loading ? (
              <span className={connectionStyles.visuallyHidden} role="status">
                Loading GitHub connection…
              </span>
            ) : null}
          </div>
        </div>

        <div className={connectionStyles.actions}>
          {loading ? (
            <span
              className={connectionStyles.buttonPlaceholder}
              aria-hidden="true"
            />
          ) : loadError ? (
            <button
              type="button"
              onClick={handleRetry}
              className={connectionStyles.secondaryButton}
            >
              Retry
            </button>
          ) : githubIdentity ? null : (
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              aria-busy={connecting}
              className={connectionStyles.connectButton}
            >
              {connecting ? 'Redirecting…' : 'Connect GitHub'}
            </button>
          )}
        </div>
      </div>

      <p className={connectionStyles.identityNote}>
        Zaplie matches your stable GitHub account ID, so changing your username
        won't interrupt reward routing.
      </p>
    </section>
  );
};

export default ConnectionsSetting;
