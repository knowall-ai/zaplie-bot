import React, { FunctionComponent, useEffect, useState } from 'react';
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

// Per-event rule metadata for the list; the amounts themselves come from /api/reward-amounts.
const RULE_META: Record<
  string,
  {
    title: string;
    icon: string;
    status: string;
    sentence: (sats: number) => string;
  }
> = {
  githubPrMergedSats: {
    title: 'Pull request merged',
    icon: GithubIcon,
    status: 'Draft flow',
    sentence: sats =>
      `When a pull request is merged in a connected repository, the author gets ${sats} sats.`,
  },
  githubIssueClosedSats: {
    title: 'Issue closed',
    icon: GithubIcon,
    status: 'Flow required',
    sentence: sats =>
      `Reserved amount: ${sats} sats. This event needs its own verified GitHub flow.`,
  },
  githubReviewSubmittedSats: {
    title: 'Review submitted',
    icon: GithubIcon,
    status: 'Flow required',
    sentence: sats =>
      `Reserved amount: ${sats} sats. This event needs its own verified GitHub flow.`,
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
  const [webhookKeys, setWebhookKeys] = useState<WebhookKey[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [automations, rewardAmounts] = await Promise.all([
          getAutomations(),
          getRewardAmounts(),
        ]);
        setRepos(automations.repos || []);
        setAmounts(rewardAmounts.rewardAmounts || {});
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to load automations',
        );
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const isAdmin = isZaplieAdmin(accounts[0]);

  useEffect(() => {
    if (!accounts[0]) {
      setStatsLoading(false);
      return;
    }
    setStatsLoading(true);
    const loadConnections = async () => {
      try {
        const idToken = await acquireIdToken(instance, accounts[0]);
        const [connection, statsData, keys] = await Promise.all([
          getGithubConnection(idToken),
          getAutomationsStats(idToken),
          isAdmin ? getWebhookKeys(idToken) : Promise.resolve([]),
        ]);
        setAppInstalled(connection.connected);
        setStats(statsData);
        setWebhookKeys(keys);
      } catch (err) {
        console.error('Error fetching connections state:', err);
        toast.error('Could not load connection status.');
      } finally {
        setStatsLoading(false);
      }
    };
    loadConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, accounts, instance]);

  const handleCreateKey = async () => {
    const label = newKeyLabel.trim();
    if (!label) {
      toast.error('Give the key a label, like "GitHub Logic App".');
      return;
    }
    setCreatingKey(true);
    try {
      const idToken = await acquireIdToken(instance, accounts[0]);
      const created = await createWebhookKey(idToken, label);
      setCreatedKey(created.key);
      setNewKeyLabel('');
      setWebhookKeys(await getWebhookKeys(idToken));
    } catch (err) {
      console.error('Error creating webhook key:', err);
      toast.error('Could not create the API key.');
    } finally {
      setCreatingKey(false);
    }
  };

  const handleRevokeKey = async (id: string) => {
    try {
      const idToken = await acquireIdToken(instance, accounts[0]);
      await revokeWebhookKey(idToken, id);
      setWebhookKeys(await getWebhookKeys(idToken));
      toast.success('Key revoked. Flows using it stop working immediately.');
    } catch (err) {
      console.error('Error revoking webhook key:', err);
      toast.error('Could not revoke the API key.');
    }
  };

  const persistRepos = async (next: string[]) => {
    setSaving(true);
    try {
      const idToken = await acquireIdToken(instance, accounts[0]);
      const data = await updateAutomations(idToken, next);
      setRepos(data.repos);
    } catch (err) {
      toast.error('Could not update connected repositories.');
    } finally {
      setSaving(false);
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
    setInstalling(true);
    try {
      const tokenResponse = await instance.acquireTokenSilent({
        ...loginRequest,
        account,
        forceRefresh: true,
      });
      const installUrl = await getGithubInstallUrl(tokenResponse.idToken);
      window.location.href = installUrl;
    } catch (err) {
      console.error('Error starting repository install:', err);
      toast.error('Could not start the GitHub App install.');
      setInstalling(false);
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
    try {
      const idToken = await acquireIdToken(instance, accounts[0]);
      // `amounts` only changes on a successful save, so another card's unsaved edit can't bleed in here.
      const data = await updateRewardAmounts(idToken, {
        ...amounts,
        [key]: nextAmount,
      });
      setAmounts(data.rewardAmounts);
      setEditingKey(null);
      toast.success('Reward amount updated.');
    } catch (err) {
      toast.error('Could not update the reward amount.');
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
          <p className={styles.emptyState}>
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
            Connect GitHub and deploy the pull-request sample flow.
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
            Create a key for the GitHub pull-request sample flow. Production use
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
      <div className={styles.ruleGrid}>
        {RULE_ORDER.filter(key => key in amounts).map(key => {
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
              <div className={styles.ruleInfo}>
                <span className={styles.ruleTitle}>{meta.title}</span>
                <span className={styles.ruleSentence}>
                  {meta.sentence(amounts[key])}
                </span>
              </div>
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
                  <span className={styles.satsChip}>
                    <img src={ZapIcon} alt="" />
                    {NUMBER_FORMATTER.format(amounts[key])} sats
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

      <ToastContainer />
    </div>
  );
};

export default AutomationsComponent;
