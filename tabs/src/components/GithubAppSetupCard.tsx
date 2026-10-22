import React, { FunctionComponent, useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import styles from './AutomationsComponent.module.css';
import { acquireIdToken } from '../services/adminRole';
import {
  getGithubSetupStatus,
  GithubSetupStatus,
  startGithubAppCreation,
} from '../services/setupService';

// Strips the ?setup=... param the manifest callback returns to Automations
// with, after surfacing it as a toast, so a page refresh doesn't re-show it.
export const useGithubSetupReturnStatus = () => {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('setup');
    if (!status) {
      return;
    }
    if (status === 'github_created') {
      toast.success('GitHub App created. You can connect repositories now.');
    } else {
      toast.error('Creating the GitHub App failed. Please try again.');
    }
    params.delete('setup');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
  }, []);
};

// The server decides: an env slug alone, say, reports source 'env' but cannot
// list the installation's repositories without the App key.
export const isGithubAppReady = (status: GithubSetupStatus) =>
  status.installationReady;

// Covers the token acquisition and the status request together, so a stalled
// one cannot leave the card on "Checking" with its controls hidden.
const STATUS_TIMEOUT_MS = 15_000;

// Admin-only block inside the GitHub connection card: creates the org's own
// GitHub App through the manifest flow. Mount it keyed by account so a switch
// never shows the previous account's status.
const GithubAppSetupCard: FunctionComponent<{
  onStatus: (status: GithubSetupStatus) => void;
}> = ({ onStatus }) => {
  const { instance, accounts } = useMsal();
  const [status, setStatus] = useState<GithubSetupStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [organization, setOrganization] = useState('');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
      if (!cancelled) {
        console.error('GitHub App status timed out');
        setLoadError(true);
      }
    }, STATUS_TIMEOUT_MS);
    const load = async () => {
      try {
        const account = accounts[0];
        if (!account) {
          return;
        }
        const idToken = await acquireIdToken(instance, account);
        if (controller.signal.aborted) {
          return;
        }
        const next = await getGithubSetupStatus(idToken, controller.signal);
        if (cancelled || controller.signal.aborted) {
          return;
        }
        setStatus(next);
        onStatus(next);
      } catch (err) {
        // The deadline already reported; an unmount reports nothing.
        if (cancelled || controller.signal.aborted) {
          return;
        }
        console.error('Error fetching GitHub App status:', err);
        setLoadError(true);
      } finally {
        clearTimeout(deadline);
      }
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(deadline);
      controller.abort();
    };
    // Mounted per account; `accounts` gets a new identity on every token
    // refresh and must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async () => {
    const account = accounts[0];
    if (!account) {
      return;
    }
    setCreating(true);
    try {
      const idToken = await acquireIdToken(instance, account);
      // Navigates away to GitHub; the button stays disabled until it does.
      await startGithubAppCreation(idToken, organization.trim() || undefined);
    } catch (err) {
      console.error('Error starting GitHub App creation:', err);
      const invalidOrganization =
        axios.isAxiosError(err) && err.response?.status === 400;
      toast.error(
        invalidOrganization
          ? 'Enter the organisation as its GitHub login, like knowall-ai.'
          : 'Could not start creating the GitHub App.',
      );
      setCreating(false);
    }
  };

  let body: React.ReactNode;
  if (loadError) {
    body = (
      <span className={styles.appSetupStatus} role="alert">
        GitHub App status is unavailable right now.
      </span>
    );
  } else if (!status) {
    body = (
      <span className={styles.appSetupStatus}>Checking the GitHub App…</span>
    );
  } else if (status.source === 'env' && status.installationReady) {
    body = (
      <span className={styles.appSetupStatus}>
        GitHub App: configured by environment
      </span>
    );
  } else if (status.created && status.installationReady) {
    body = (
      <span className={styles.appSetupStatus}>
        App created:{' '}
        {status.htmlUrl ? (
          <a href={status.htmlUrl} target="_blank" rel="noopener noreferrer">
            {status.slug}
          </a>
        ) : (
          status.slug
        )}
      </span>
    );
  } else if (status.envKeyUnreadable) {
    // Env wins over the store, so creating an App would not be used: the only
    // fix is the override itself.
    body = (
      <span className={styles.appSetupStatus} role="alert">
        GitHub App: the private key file set by GITHUB_APP_PRIVATE_KEY_PATH
        cannot be read. Correct or remove the environment override.
      </span>
    );
  } else {
    // Also reached when env vars set only part of the App (a slug without its
    // key, say). The status says so; the fix is the env vars or creating the
    // App, and the server still reports readiness either way.
    body = (
      <>
        <span className={styles.appSetupStatus}>
          {status.source === 'env'
            ? 'GitHub App: environment configuration is incomplete'
            : 'GitHub App: not created'}
        </span>
        <label className={styles.appSetupField}>
          <span>GitHub organisation that owns the repositories</span>
          <input
            type="text"
            className={styles.addInput}
            placeholder="your-org"
            value={organization}
            onChange={e => setOrganization(e.target.value)}
            disabled={creating}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <span className={styles.connHint}>
          The App is private, so GitHub only lets it be installed on the account
          that owns it. Creating it under an organisation needs an owner or App
          manager of that organisation. Leave this empty to create it under your
          own GitHub account.
        </span>
        <button
          type="button"
          className={styles.installButton}
          onClick={handleCreate}
          disabled={creating}
        >
          {creating
            ? 'Redirecting to GitHub...'
            : 'Create the Zaplie GitHub App'}
        </button>
      </>
    );
  }

  return (
    <div className={styles.appSetup} aria-busy={!status && !loadError}>
      {body}
    </div>
  );
};

export default GithubAppSetupCard;
