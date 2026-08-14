import React, { FunctionComponent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMsal } from '@azure/msal-react';
import styles from './setting.module.css';
import connectionStyles from './connections.module.css';
import GithubIcon from '../images/GitHub.svg';
import { loginRequest } from '../services/authConfig';
import {
  getMyIdentities,
  getGithubAuthorizeUrl,
  LinkedIdentity,
} from '../services/identityService';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

// Strips the ?github=... return param GitHub's OAuth callback redirects with,
// after surfacing it as a toast, so a page refresh doesn't re-show it.
const useGithubReturnStatus = () => {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('github');
    if (!status) {
      return;
    }
    if (status === 'connected') {
      toast.success('GitHub connected successfully!');
    } else if (status === 'repos_connected') {
      toast.success('Repositories connected successfully!');
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
  const [identities, setIdentities] = useState<LinkedIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  useGithubReturnStatus();

  useEffect(() => {
    const account = accounts[0];
    if (!account) {
      setLoading(false);
      return;
    }
    const load = async () => {
      try {
        // forceRefresh: acquireTokenSilent can serve a cached, already-expired
        // idToken; the backend verifies exp and would reject it with a 401.
        const tokenResponse = await instance.acquireTokenSilent({
          ...loginRequest,
          account,
          forceRefresh: true,
        });
        const mine = await getMyIdentities(tokenResponse.idToken);
        setIdentities(mine);
      } catch (error) {
        console.error('Error fetching identities:', error);
        toast.error('Could not load your GitHub connection.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [accounts, instance]);

  const handleConnect = async () => {
    const account = accounts[0];
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
    } catch (error) {
      console.error('Error starting GitHub connect:', error);
      toast.error('Could not start the GitHub connection.');
      setConnecting(false);
    }
  };

  const githubIdentity = identities.find(
    identity => identity.provider === 'github',
  );

  return (
    <div className={styles.currencySetting}>
      <section className={styles.settingCard}>
        <div className={styles.cardHeader}>
          <div className={styles.sectionHeading}>
            <h2>Connections</h2>
            <p>External accounts linked to your Zaplie profile.</p>
          </div>
        </div>
        <div className={styles.sectionBlock}>
          <div className={connectionStyles.row}>
            <img
              src={GithubIcon}
              alt="GitHub"
              className={connectionStyles.icon}
            />
            <div className={connectionStyles.cardText}>
              <span className={connectionStyles.cardTitle}>GitHub</span>
              <span className={connectionStyles.cardHint}>
                Link your account so eligible GitHub rewards can resolve to your
                wallet. The pull-request flow is still a draft pilot.
              </span>
            </div>
            {loading ? (
              <span className={connectionStyles.status}>Loading...</span>
            ) : githubIdentity ? (
              <span className={connectionStyles.connected}>
                Connected as @{githubIdentity.providerHandle}
              </span>
            ) : (
              <button
                onClick={handleConnect}
                disabled={connecting}
                className={connectionStyles.connectButton}
              >
                {connecting ? 'Redirecting…' : 'Connect GitHub'}
              </button>
            )}
          </div>
          <span className={connectionStyles.footnote}>
            Repositories and more organisation connections are managed in{' '}
            <Link to="/automations" className={connectionStyles.footnoteLink}>
              Automations
            </Link>
            .
          </span>
        </div>
      </section>
      <ToastContainer />
    </div>
  );
};

export default ConnectionsSetting;
