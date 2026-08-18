import React, { FunctionComponent, useEffect, useRef, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import styles from './AutomationsComponent.module.css';
import {
  getAutomations,
  updateAutomations,
  getRewardAmounts,
  updateRewardAmounts,
} from '../apiService';
import { loginRequest } from '../services/authConfig';
import { acquireIdToken, isZaplieAdmin } from '../services/adminRole';
import {
  getGithubInstallUrl,
  getGithubConnection,
} from '../services/connectionsService';
import {
  getAutomationsStats,
  AutomationsStats,
  AutomationAudience,
  AutomationRecipient,
} from '../services/automationsStatsService';
import {
  getWebhookKeys,
  createWebhookKey,
  revokeWebhookKey,
  WebhookKey,
} from '../services/webhookKeysService';
import GithubIcon from '../images/GitHub.svg';
import ZapIcon from '../images/ZapIcon.svg';
import MicrosoftIcon from '../images/Microsoft.svg';
import SlackIcon from '../images/Slack.svg';
import FlowArrowIcon from '../images/FlowArrow.svg';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Per-event rule metadata for the list; the amounts themselves come from /api/reward-amounts
// and the run counts from /api/automations-stats. Nothing here is a metric.
const RULE_META: Record<
  string,
  {
    audience: AutomationAudience;
    eventType: string;
    title: string;
    icon: string;
    status: string;
    note?: string;
  }
> = {
  githubPrMergedSats: {
    audience: 'teammates',
    eventType: 'githubPrMerged',
    title: 'For every pull request merged in a connected repository',
    icon: GithubIcon,
    status: 'Draft flow',
  },
  githubIssueClosedSats: {
    audience: 'teammates',
    eventType: 'githubIssueClosed',
    title: 'For every issue closed in a connected repository',
    icon: GithubIcon,
    status: 'Flow required',
    note: 'Amount is reserved. This event still needs its own verified GitHub flow.',
  },
  githubReviewSubmittedSats: {
    audience: 'teammates',
    eventType: 'githubReviewSubmitted',
    title: 'For every review submitted on a pull request',
    icon: GithubIcon,
    status: 'Flow required',
    note: 'Amount is reserved. This event still needs its own verified GitHub flow.',
  },
};
const RULE_ORDER = [
  'githubPrMergedSats',
  'githubIssueClosedSats',
  'githubReviewSubmittedSats',
];

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');
const DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const AUDIENCES: Array<{ key: AutomationAudience; label: string }> = [
  { key: 'teammates', label: 'teammates' },
  { key: 'copilots', label: 'copilots' },
  { key: 'customers', label: 'customers' },
];

const EngagementPanel: FunctionComponent<{
  label: string;
  recipients: AutomationRecipient[];
}> = ({ label, recipients }) => {
  const maxSats = Math.max(
    ...recipients.map(recipient => recipient.paidSats),
    1,
  );
  return (
    <article className={styles.engagementPanel}>
      <h4 className={styles.engagementTitle}>Most engaged {label}</h4>
      {recipients.length === 0 ? (
        <p className={styles.emptyState}>No automated payouts this month.</p>
      ) : (
        <ol className={styles.engagementList}>
          {recipients.map(recipient => (
            <li key={recipient.id} className={styles.engagementItem}>
              <span className={styles.avatar} aria-hidden="true">
                {recipient.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className={styles.engagementDetails}>
                <span className={styles.engagementName}>
                  {recipient.displayName}
                </span>
                <span className={styles.engagementTrack} aria-hidden="true">
                  <span
                    className={styles.engagementFill}
                    style={{
                      width: `${Math.max(8, (recipient.paidSats / maxSats) * 100)}%`,
                    }}
                  />
                </span>
              </span>
              <span className={styles.engagementValue}>
                {NUMBER_FORMATTER.format(recipient.paidSats)} sats
                <small>{recipient.paymentCount} payments</small>
              </span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
};

const AutomationsComponent: FunctionComponent = () => {
  const { instance, accounts } = useMsal();
  const [repos, setRepos] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [newRepo, setNewRepo] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appInstalled, setAppInstalled] = useState(false);
  const [stats, setStats] = useState<AutomationsStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);
  const [webhookKeys, setWebhookKeys] = useState<WebhookKey[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [ruleAudience, setRuleAudience] =
    useState<AutomationAudience>('teammates');

  const accountId = accounts[0]?.homeAccountId;
  // Read after an await to tell whether the account changed mid-flight. A ref,
  // not the closed-over `accountId`, so a handler started under the previous
  // account sees the current value rather than the one it captured.
  const accountIdRef = useRef(accountId);
  const stillSameAccount = (startedAs: string | undefined) =>
    accountIdRef.current === startedAs;

  // Everything below is account-scoped. Reset it the moment the signed-in
  // account changes, before the reloads start: a slow or hanging request would
  // otherwise let the new account read the previous one's repos, reward
  // amounts, treasury metrics, GitHub banner and key labels. Declared ahead of
  // the load effects so it runs first, and keyed on the account id rather than
  // the `accounts` array, which useMsal gives a new identity on every token
  // refresh — that would wipe the one-time plaintext key mid-copy.
  useEffect(() => {
    accountIdRef.current = accountId;
    setRepos([]);
    setAmounts({});
    setAppInstalled(false);
    setStats(null);
    setWebhookKeys([]);
    setCreatedKey(null);
    setError(null);
    setStatsError(false);
    setLoading(true);
    setStatsLoading(true);
    // In-progress edits belong to the previous account: the same rule key
    // could otherwise open in edit mode holding the old account's amount, and
    // saving it would write that stale value.
    setEditingKey(null);
    setEditingValue('');
    setNewRepo('');
    setNewKeyLabel('');
    // A handler still in flight for the previous account skips its own
    // finally, so its flags have to be cleared here or the new account
    // inherits a permanently disabled "Creating..." or saving control.
    setCreatingKey(false);
    setSaving(false);
    setInstalling(false);
  }, [accountId]);

  useEffect(() => {
    // Same guard as the connections effect below: `accounts` gets a new
    // identity on every token refresh, so account 1's response must not be
    // able to overwrite repos/amounts after account 2's has landed.
    let cancelled = false;
    const load = async () => {
      try {
        const account = accounts[0];
        if (!account) {
          throw new Error('You need to be signed in to view automations.');
        }
        const idToken = await acquireIdToken(instance, account);
        const [automations, rewardAmounts] = await Promise.all([
          getAutomations(idToken),
          getRewardAmounts(idToken),
        ]);
        if (cancelled) {
          return;
        }
        setRepos(automations.repos || []);
        setAmounts(rewardAmounts.rewardAmounts || {});
      } catch (err) {
        if (cancelled) {
          return;
        }
        setError(
          err instanceof Error ? err.message : 'Failed to load automations',
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    load();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, instance]);

  const isAdmin = isZaplieAdmin(accounts[0]);

  useEffect(() => {
    if (!accounts[0]) {
      setStatsLoading(false);
      return;
    }
    // `accounts` from useMsal gets a new identity on every token refresh, so
    // this effect re-runs while its previous run is still in flight. Without
    // this flag a slow run-1 rejection could land after run-2 succeeded and
    // blank good data, and run-1's finally would clear the loading state while
    // run-2 was still loading.
    let cancelled = false;
    setStatsLoading(true);
    setStatsError(false);
    const loadConnections = async () => {
      let idToken: string;
      try {
        idToken = await acquireIdToken(instance, accounts[0]);
      } catch (err) {
        if (cancelled) {
          return;
        }
        console.error('Error acquiring a token for automations:', err);
        toast.error('Could not load connection status.');
        // No token means none of the three panels can be refreshed, so clear
        // all of the account-scoped state rather than leaving the previous
        // account's stats, banner and key labels on screen under an error.
        // Defence in depth: the sibling load effect shares this token and
        // already replaces the whole view with its error page, so this is not
        // separately observable — but it must not depend on that.
        setStats(null);
        setAppInstalled(false);
        setWebhookKeys([]);
        setStatsError(true);
        setStatsLoading(false);
        return;
      }
      if (cancelled) {
        return;
      }

      // Three independent chains, not Promise.all/allSettled: the treasury
      // stats call is LNbits-backed and both the slowest and the likeliest to
      // fail. Bundling it used to hide the GitHub-connected banner and the
      // API-keys list behind one generic toast, and would still make them wait
      // on it. Each panel now lands as soon as its own request settles.
      //
      // Every catch clears its own panel: these are account-scoped, so leaving
      // the previous account's banner or key labels on screen after a failed
      // reload would show one user another user's automation state.
      void getGithubConnection(idToken)
        .then(connection => {
          if (cancelled) {
            return;
          }
          setAppInstalled(connection.connected);
        })
        .catch(err => {
          if (cancelled) {
            return;
          }
          console.error('Error fetching GitHub connection:', err);
          setAppInstalled(false);
          toast.error('Could not load connection status.');
        });

      void getAutomationsStats(idToken)
        .then(statsData => {
          if (cancelled) {
            return;
          }
          setStats(statsData);
          setStatsError(false);
        })
        .catch(err => {
          if (cancelled) {
            return;
          }
          console.error('Error fetching automations stats:', err);
          // Drop the previous summary too: the render path checks `stats`
          // first, so stale recipients and history would otherwise sit there
          // looking current while the refresh that replaced them had failed.
          setStats(null);
          setStatsError(true);
        })
        .finally(() => {
          if (cancelled) {
            return;
          }
          setStatsLoading(false);
        });

      void (isAdmin ? getWebhookKeys(idToken) : Promise.resolve([]))
        .then(keys => {
          if (cancelled) {
            return;
          }
          setWebhookKeys(keys);
        })
        .catch(err => {
          if (cancelled) {
            return;
          }
          console.error('Error fetching webhook keys:', err);
          setWebhookKeys([]);
          toast.error('Could not load the API keys.');
        });
    };
    loadConnections();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, accounts, instance]);

  const handleCreateKey = async () => {
    const label = newKeyLabel.trim();
    if (!label) {
      toast.error('Give the key a label, like "GitHub Logic App".');
      return;
    }
    const startedAs = accountId;
    setCreatingKey(true);
    try {
      const idToken = await acquireIdToken(instance, accounts[0]);
      const created = await createWebhookKey(idToken, label);
      // The account changed while this was in flight: putting the plaintext
      // key on screen now would show it to whoever is signed in instead.
      if (!stillSameAccount(startedAs)) {
        return;
      }
      // Surface the secret before refreshing the list. The key already exists
      // server-side and its plaintext is returned exactly once, so a failed
      // refresh must not cost the admin the only copy.
      setCreatedKey(created.key);
      setNewKeyLabel('');
      try {
        const keys = await getWebhookKeys(idToken);
        if (stillSameAccount(startedAs)) {
          setWebhookKeys(keys);
        }
      } catch (refreshErr) {
        console.error(
          'Error refreshing webhook keys after create:',
          refreshErr,
        );
        if (stillSameAccount(startedAs)) {
          toast.error('Key created, but the list could not be refreshed.');
        }
      }
    } catch (err) {
      console.error('Error creating webhook key:', err);
      if (stillSameAccount(startedAs)) {
        toast.error('Could not create the API key.');
      }
    } finally {
      if (stillSameAccount(startedAs)) {
        setCreatingKey(false);
      }
    }
  };

  const handleRevokeKey = async (id: string) => {
    const startedAs = accountId;
    try {
      const idToken = await acquireIdToken(instance, accounts[0]);
      await revokeWebhookKey(idToken, id);
      const keys = await getWebhookKeys(idToken);
      if (!stillSameAccount(startedAs)) {
        return;
      }
      setWebhookKeys(keys);
      toast.success('Key revoked. Flows using it stop working immediately.');
    } catch (err) {
      console.error('Error revoking webhook key:', err);
      if (stillSameAccount(startedAs)) {
        toast.error('Could not revoke the API key.');
      }
    }
  };

  const persistRepos = async (next: string[]) => {
    const startedAs = accountId;
    setSaving(true);
    try {
      const idToken = await acquireIdToken(instance, accounts[0]);
      const data = await updateAutomations(idToken, next);
      if (!stillSameAccount(startedAs)) {
        return;
      }
      setRepos(data.repos);
    } catch (err) {
      if (stillSameAccount(startedAs)) {
        toast.error('Could not update connected repositories.');
      }
    } finally {
      if (stillSameAccount(startedAs)) {
        setSaving(false);
      }
    }
  };

  const handleAddRepo = () => {
    const repo = newRepo.trim();
    if (!REPO_PATTERN.test(repo)) {
      toast.error('Enter a repository as owner/repo.');
      return;
    }
    if (repos.includes(repo)) {
      toast.error('That repository is already connected.');
      return;
    }
    setNewRepo('');
    persistRepos([...repos, repo]);
  };

  const handleRemoveRepo = (repo: string) => {
    persistRepos(repos.filter(existing => existing !== repo));
  };

  const handleInstallApp = async () => {
    const account = accounts[0];
    if (!account) {
      return;
    }
    const startedAs = accountId;
    setInstalling(true);
    try {
      const tokenResponse = await instance.acquireTokenSilent({
        ...loginRequest,
        account,
        forceRefresh: true,
      });
      const installUrl = await getGithubInstallUrl(tokenResponse.idToken);
      // The backend signs the redirect state with the requesting token's oid,
      // so following this URL after an account switch would attach the GitHub
      // installation to the account that is no longer signed in.
      if (!stillSameAccount(startedAs)) {
        return;
      }
      window.location.href = installUrl;
    } catch (err) {
      console.error('Error starting repository install:', err);
      if (stillSameAccount(startedAs)) {
        toast.error('Could not start the GitHub App install.');
        setInstalling(false);
      }
    }
  };

  const handleStartEdit = (key: string) => {
    setEditingKey(key);
    setEditingValue(String(amounts[key]));
  };

  const handleSaveAmount = async (key: string) => {
    const nextAmount = Number(editingValue);
    if (!Number.isInteger(nextAmount) || nextAmount <= 0) {
      toast.error('Reward amount must be a positive whole number of sats.');
      return;
    }
    const startedAs = accountId;
    try {
      const idToken = await acquireIdToken(instance, accounts[0]);
      // `amounts` only changes on a successful save, so another card's unsaved edit can't bleed in here.
      const data = await updateRewardAmounts(idToken, {
        ...amounts,
        [key]: nextAmount,
      });
      if (!stillSameAccount(startedAs)) {
        return;
      }
      setAmounts(data.rewardAmounts);
      setEditingKey(null);
      toast.success('Reward amount updated.');
    } catch (err) {
      if (stillSameAccount(startedAs)) {
        toast.error('Could not update the reward amount.');
      }
    }
  };

  if (loading) {
    return (
      <div className={styles.automationscomponent}>
        <p className={styles.subtitle}>Loading automations...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.automationscomponent}>
        <p className={styles.errorText}>{error}</p>
      </div>
    );
  }

  const activeWebhookKeyCount = webhookKeys.filter(
    key => !key.revokedAt,
  ).length;
  const visibleRuleKeys = RULE_ORDER.filter(
    key => key in amounts && RULE_META[key].audience === ruleAudience,
  );

  return (
    <div className={styles.automationscomponent}>
      <header className={styles.banner}>
        <div className={styles.bannerText}>
          <span className={styles.eyebrow}>Workflow control centre</span>
          <h2 className={styles.title}>Automations</h2>
          <p className={styles.bannerSubtitle}>
            Preview the GitHub rewards pilot, configure its rules and inspect
            recorded treasury activity. Keep its treasury unfunded until the
            safety blockers are closed.
          </p>
          <nav className={styles.sectionNav} aria-label="Automations sections">
            <a href="#automation-engagement">Recipients</a>
            <a href="#automation-history">History</a>
            <a href="#automation-connections">Connections</a>
            <a href="#automation-rules">Reward rules</a>
          </nav>
        </div>
        <div className={styles.bannerMetric}>
          <span className={styles.bannerMetricValue}>
            {stats ? NUMBER_FORMATTER.format(stats.paymentsThisMonth) : '—'}
          </span>
          <span className={styles.bannerMetricLabel}>
            payments automated this month
          </span>
        </div>
      </header>

      {stats && (
        <div className={styles.statPanel}>
          <div className={styles.statHero}>
            <span className={styles.statHeroLabel}>Total automated</span>
            <span className={styles.statHeroValue}>
              {NUMBER_FORMATTER.format(stats.paidSatsThisMonth)}
              <span className={styles.statHeroUnit}> sats</span>
            </span>
            <span className={styles.statHeroSub}>this month</span>
          </div>
          <div className={styles.statRows}>
            <div className={styles.statRow}>
              <span className={styles.statRowLabel}>Automated payments</span>
              <span className={styles.statRowValue}>
                {stats.paymentsThisMonth}
              </span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statRowLabel}>Reward rules</span>
              <span className={styles.statRowValue}>
                {RULE_ORDER.filter(key => key in amounts).length}
              </span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statRowLabel}>Repositories watched</span>
              <span className={styles.statRowValue}>{repos.length}</span>
            </div>
          </div>
        </div>
      )}

      <section id="automation-engagement" className={styles.activitySection}>
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.sectionKicker}>Live treasury data</span>
            <h3 className={styles.sectionHeading}>
              Who automation is rewarding
            </h3>
          </div>
          <p>Ranked by completed automated payments this month.</p>
        </div>
        {statsLoading ? (
          <p className={styles.emptyState}>Loading recipient activity…</p>
        ) : stats ? (
          <div className={styles.engagementScroller}>
            {AUDIENCES.map(audience => (
              <EngagementPanel
                key={audience.key}
                label={audience.label}
                recipients={stats.engagementByAudience[audience.key]}
              />
            ))}
          </div>
        ) : (
          <p
            className={styles.emptyState}
            role={statsError ? 'alert' : undefined}
          >
            Recipient activity is unavailable right now.
          </p>
        )}
      </section>

      <section id="automation-history" className={styles.activitySection}>
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.sectionKicker}>Audit trail</span>
            <h3 className={styles.sectionHeading}>History</h3>
          </div>
          <p>Latest completed payouts from the automation treasury.</p>
        </div>
        {statsLoading ? (
          <p className={styles.emptyState}>Loading automation history…</p>
        ) : stats && stats.recentPayments.length > 0 ? (
          <ol className={styles.historyList}>
            {stats.recentPayments.map(payment => (
              <li key={payment.id} className={styles.historyItem}>
                <span className={styles.historySource}>{payment.source}</span>
                <span className={styles.historyCopy}>
                  <strong>{payment.memo}</strong>
                  <span>
                    {payment.recipient.displayName}
                    {payment.paidAt ? (
                      <>
                        {' · '}
                        <time dateTime={payment.paidAt}>
                          {DATE_FORMATTER.format(new Date(payment.paidAt))}
                        </time>
                      </>
                    ) : null}
                  </span>
                </span>
                <span className={styles.historyAmount}>
                  +{NUMBER_FORMATTER.format(payment.amountSats)} sats
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.emptyState}>
            {stats
              ? 'No automated payouts have been recorded yet.'
              : 'Automation history is unavailable right now.'}
          </p>
        )}
      </section>

      <div className={styles.steps}>
        <div className={styles.step}>
          <span className={styles.stepNum}>1</span>
          <span className={styles.stepText}>
            Connect GitHub and deploy the pull-request reward flow.
          </span>
        </div>
        <div className={styles.step}>
          <span className={styles.stepNum}>2</span>
          <span className={styles.stepText}>
            Set the reward amount for each event.
          </span>
        </div>
        <div className={styles.step}>
          <span className={styles.stepNum}>3</span>
          <span className={styles.stepText}>
            Teammates link their accounts once in Settings, then rewards land in
            their wallet.
          </span>
        </div>
      </div>

      <h3 id="automation-connections" className={styles.sectionHeading}>
        Connections
      </h3>
      <div className={styles.connGrid}>
        <div className={styles.connCard}>
          <div className={styles.connCardHead}>
            <span className={styles.cardBadge}>
              <img src={GithubIcon} alt="" />
            </span>
            <div className={styles.connCardTitle}>
              <span className={styles.connName}>GitHub</span>
              <span className={styles.connStatus}>
                {repos.length > 0
                  ? `Watching ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}`
                  : appInstalled
                    ? 'App installed'
                    : 'Not connected yet'}
              </span>
            </div>
          </div>
          <p className={styles.connDescription}>
            Install the Zaplie GitHub App and pick repositories for the draft
            pull-request flow. Issue and review rewards require separate
            verified flows.
          </p>
          {appInstalled && repos.length === 0 && (
            <span className={styles.connHint}>
              Installed on GitHub. Syncing the repository list needs the App
              private key on the server; add repositories manually meanwhile.
            </span>
          )}
          {repos.length > 0 && (
            <div className={styles.repoChips}>
              {repos.map(repo => (
                <span key={repo} className={styles.repoChip}>
                  {repo}
                  {isAdmin && (
                    <button
                      className={styles.repoChipRemove}
                      onClick={() => handleRemoveRepo(repo)}
                      disabled={saving}
                      title={`Remove ${repo}`}
                    >
                      &times;
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {isAdmin && (
            <div className={styles.connCardActions}>
              <button
                className={styles.installButton}
                onClick={handleInstallApp}
                disabled={installing}
              >
                {installing
                  ? 'Redirecting to GitHub...'
                  : repos.length > 0
                    ? 'Configure repositories'
                    : 'Connect repositories'}
              </button>
              <details className={styles.manualAdd}>
                <summary className={styles.manualAddSummary}>
                  Add manually
                </summary>
                <div className={styles.addRow}>
                  <input
                    type="text"
                    placeholder="owner/repo"
                    value={newRepo}
                    onChange={e => setNewRepo(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddRepo()}
                    className={styles.addInput}
                    disabled={saving}
                  />
                  <button
                    className={styles.addButton}
                    onClick={handleAddRepo}
                    disabled={saving}
                  >
                    Add
                  </button>
                </div>
              </details>
            </div>
          )}
        </div>

        <div className={styles.connCard}>
          <div className={styles.connCardHead}>
            <span className={styles.cardBadge}>
              <img src={FlowArrowIcon} alt="" />
            </span>
            <div className={styles.connCardTitle}>
              <span className={styles.connName}>GitHub Logic Apps pilot</span>
              <span className={styles.connStatus}>
                Draft — not production ready
              </span>
            </div>
          </div>
          <p className={styles.connDescription}>
            Create a key for the GitHub pull-request reward flow. Production use
            remains blocked until durable idempotency and aggregate budget
            controls land.
          </p>
          {isAdmin && (
            <>
              {activeWebhookKeyCount > 0 && (
                <div className={styles.keyList}>
                  {webhookKeys
                    .filter(k => !k.revokedAt)
                    .map(k => (
                      <div key={k.id} className={styles.keyRow}>
                        <span className={styles.keyLabel}>{k.label}</span>
                        <span className={styles.keyMeta}>····{k.last4}</span>
                        <button
                          className={styles.keyRevoke}
                          onClick={() => handleRevokeKey(k.id)}
                        >
                          Revoke
                        </button>
                      </div>
                    ))}
                </div>
              )}
              {createdKey && (
                <div className={styles.createdKeyBox}>
                  <span className={styles.createdKeyHint}>
                    Copy this key now. It is shown only once.
                  </span>
                  <div className={styles.createdKeyRow}>
                    <code className={styles.createdKeyValue}>{createdKey}</code>
                    <button
                      className={styles.addButton}
                      onClick={() => {
                        navigator.clipboard.writeText(createdKey);
                        toast.success('Key copied.');
                      }}
                    >
                      Copy
                    </button>
                    <button
                      className={styles.cardEditButton}
                      onClick={() => setCreatedKey(null)}
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
              <div className={styles.addRow}>
                <input
                  type="text"
                  placeholder='Key label, like "GitHub Logic App"'
                  value={newKeyLabel}
                  onChange={e => setNewKeyLabel(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateKey()}
                  className={styles.addInput}
                  disabled={creatingKey}
                />
                <button
                  className={styles.addButton}
                  onClick={handleCreateKey}
                  disabled={creatingKey}
                >
                  {creatingKey ? 'Creating...' : 'Create key'}
                </button>
              </div>
            </>
          )}
        </div>

        <div className={styles.connCard}>
          <div className={styles.connCardHead}>
            <span className={styles.cardBadge}>
              <img src={MicrosoftIcon} alt="" />
            </span>
            <div className={styles.connCardTitle}>
              <span className={styles.connName}>Microsoft 365</span>
              <span className={styles.connStatus}>Calendar live today</span>
            </div>
          </div>
          <p className={styles.connDescription}>
            Calendar and people signals from Microsoft Graph already power Your
            week and the assistant's suggestions. Shared inbox digests are next.
          </p>
        </div>

        <div className={`${styles.connCard} ${styles.comingSoonCard}`}>
          <div className={styles.connCardHead}>
            <span className={styles.cardBadge}>
              <img src={SlackIcon} alt="" />
            </span>
            <div className={styles.connCardTitle}>
              <span className={styles.connName}>Slack</span>
              <span className={styles.comingSoonBadge}>Coming soon</span>
            </div>
          </div>
          <p className={styles.connDescription}>
            A Slack agent with the same recognition model, for teams outside
            Microsoft Teams.
          </p>
        </div>
      </div>

      <div id="automation-rules" className={styles.sectionHeader}>
        <div>
          <span className={styles.sectionKicker}>Admin controlled</span>
          <h3 className={styles.sectionHeading}>Reward rules</h3>
        </div>
        <p>
          Every amount is enforced again by the server before it is saved or
          paid.
        </p>
      </div>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Reward rules by audience"
      >
        {AUDIENCES.map(audience => {
          const selected = ruleAudience === audience.key;
          return (
            <button
              key={audience.key}
              type="button"
              role="tab"
              id={`rule-tab-${audience.key}`}
              aria-selected={selected}
              aria-controls="rule-panel"
              className={`${styles.tab} ${selected ? styles.tabActive : ''}`}
              onClick={() => setRuleAudience(audience.key)}
            >
              For {audience.label}
            </button>
          );
        })}
      </div>
      {visibleRuleKeys.length === 0 ? (
        <p
          id="rule-panel"
          role="tabpanel"
          aria-labelledby={`rule-tab-${ruleAudience}`}
          className={styles.emptyState}
        >
          No reward rules pay {ruleAudience} yet. The GitHub pilot rewards the
          teammate behind the event.
        </p>
      ) : (
        <div
          id="rule-panel"
          role="tabpanel"
          aria-labelledby={`rule-tab-${ruleAudience}`}
          className={styles.ruleGrid}
        >
          {visibleRuleKeys.map(key => {
            const meta = RULE_META[key];
            const isEditing = editingKey === key;
            return (
              <article key={key} className={styles.ruleCard}>
                <div className={styles.ruleCardHeader}>
                  <span className={styles.cardBadge}>
                    <img src={meta.icon} alt="" />
                  </span>
                  <span className={styles.ruleStatus}>{meta.status}</span>
                </div>
                <h4 className={styles.ruleTitle}>{meta.title}</h4>
                <ul className={styles.ruleMeta}>
                  {stats && (
                    <li className={styles.ruleMetaRow}>
                      <img
                        className={styles.ruleMetaIcon}
                        src={FlowArrowIcon}
                        alt=""
                      />
                      <strong>
                        {stats.runsByEventType?.[meta.eventType] ?? 0}
                      </strong>
                      <span>runs this month</span>
                    </li>
                  )}
                  {meta.note && (
                    <li className={styles.ruleMetaNote}>{meta.note}</li>
                  )}
                </ul>
                <div className={styles.ruleFooter}>
                  {isEditing ? (
                    <label className={styles.amountEditor}>
                      <span>Sats</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={editingValue}
                        onChange={e => setEditingValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            handleSaveAmount(key);
                          }
                          if (e.key === 'Escape') {
                            setEditingKey(null);
                          }
                        }}
                        className={styles.satsInput}
                        autoFocus
                      />
                    </label>
                  ) : (
                    <span className={styles.ruleAmount}>
                      <img
                        className={styles.ruleAmountIcon}
                        src={ZapIcon}
                        alt=""
                      />
                      <span className={styles.ruleAmountValue}>
                        {NUMBER_FORMATTER.format(amounts[key])}
                      </span>
                      <span className={styles.ruleAmountUnit}>Sats</span>
                    </span>
                  )}
                  {isAdmin &&
                    (isEditing ? (
                      <div className={styles.ruleActions}>
                        <button
                          className={styles.cardEditButton}
                          onClick={() => setEditingKey(null)}
                        >
                          Cancel
                        </button>
                        <button
                          className={styles.cardSaveButton}
                          onClick={() => handleSaveAmount(key)}
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <button
                        className={styles.cardEditButton}
                        onClick={() => handleStartEdit(key)}
                      >
                        Edit amount
                      </button>
                    ))}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ToastContainer />
    </div>
  );
};

export default AutomationsComponent;
