import React, { FunctionComponent, useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import styles from './AutomationsComponent.module.css';
import { getAutomations, updateAutomations, getRewardAmounts, updateRewardAmounts } from '../apiService';
import { loginRequest } from '../services/authConfig';
import { acquireIdToken, isZaplieAdmin } from '../services/adminRole';
import { getGithubInstallUrl, getGithubConnection } from '../services/connectionsService';
import {
  getGithubSetupStatus,
  startGithubAppCreation,
  GithubSetupStatus,
} from '../services/setupService';
import { getAutomationsStats, AutomationsStats } from '../services/automationsStatsService';
import {
  getWebhookKeys,
  createWebhookKey,
  revokeWebhookKey,
  WebhookKey,
} from '../services/webhookKeysService';
import GithubIcon from '../images/GitHub.svg';
import ZapIcon from '../images/ZapIcon.svg';
import AutomationsBanner from '../images/automations-banner.webp';
import RulePrMerged from '../images/rule-pr-merged.webp';
import RuleIssueClosed from '../images/rule-issue-closed.webp';
import RuleReview from '../images/rule-review.webp';
import RuleTimesheet from '../images/rule-timesheet.webp';
import MicrosoftIcon from '../images/Microsoft.svg';
import SlackIcon from '../images/Slack.svg';
import FlowArrowIcon from '../images/FlowArrow.svg';
import ClockIcon from '../images/Clock.svg';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Per-event rule metadata for the list; the amounts themselves come from /api/reward-amounts.
const RULE_META: Record<
  string,
  { title: string; icon: string; photo: string; sentence: (sats: number) => string }
> = {
  githubPrMergedSats: {
    title: 'Pull request merged',
    icon: GithubIcon,
    photo: RulePrMerged,
    sentence: sats => `When a pull request is merged in a connected repository, the author gets ${sats} sats.`,
  },
  githubIssueClosedSats: {
    title: 'Issue closed',
    icon: GithubIcon,
    photo: RuleIssueClosed,
    sentence: sats => `When an issue is closed in a connected repository, the closer gets ${sats} sats.`,
  },
  githubReviewSubmittedSats: {
    title: 'Review submitted',
    icon: GithubIcon,
    photo: RuleReview,
    sentence: sats => `When a code review is submitted in a connected repository, the reviewer gets ${sats} sats.`,
  },
  timesheetWeekSats: {
    title: 'Timesheet week complete',
    icon: ClockIcon,
    photo: RuleTimesheet,
    sentence: sats => `When a flow reports a completed timesheet week, the teammate gets ${sats} sats.`,
  },
};
const RULE_ORDER = [
  'githubPrMergedSats',
  'githubIssueClosedSats',
  'githubReviewSubmittedSats',
  'timesheetWeekSats',
];

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
  const [webhookKeys, setWebhookKeys] = useState<WebhookKey[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [setupStatus, setSetupStatus] = useState<GithubSetupStatus | null>(null);
  const [creatingApp, setCreatingApp] = useState(false);

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
        setError(err instanceof Error ? err.message : 'Failed to load automations');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const isAdmin = isZaplieAdmin(accounts[0]);

  useEffect(() => {
    if (!accounts[0]) {
      return;
    }
    const loadConnections = async () => {
      try {
        const idToken = await acquireIdToken(instance, accounts[0]);
        const connection = await getGithubConnection(idToken);
        setAppInstalled(connection.connected);
        setSetupStatus(await getGithubSetupStatus(idToken));
        setStats(await getAutomationsStats(idToken));
        if (isAdmin) {
          setWebhookKeys(await getWebhookKeys(idToken));
        }
      } catch (err) {
        console.error('Error fetching connections state:', err);
        toast.error('Could not load connection status.');
      }
    };
    loadConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, accounts, instance]);

  const handleCreateKey = async () => {
    const label = newKeyLabel.trim();
    if (!label) {
      toast.error('Give the key a label, like "Timesheet flow".');
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

  const handleCreateApp = async () => {
    if (!accounts[0]) {
      return;
    }
    setCreatingApp(true);
    try {
      const idToken = await acquireIdToken(instance, accounts[0]);
      await startGithubAppCreation(idToken);
    } catch (err) {
      console.error('Error starting GitHub App creation:', err);
      toast.error('Could not start the GitHub App creation.');
      setCreatingApp(false);
    }
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
    setEditingKey(null);
    try {
      const idToken = await acquireIdToken(instance, accounts[0]);
      // `amounts` only changes on a successful save, so another card's unsaved edit can't bleed in here.
      const data = await updateRewardAmounts(idToken, { ...amounts, [key]: Number(editingValue) });
      setAmounts(data.rewardAmounts);
      toast.success('Reward amount updated.');
    } catch (err) {
      toast.error('Could not update the reward amount.');
    }
  };

  if (loading) {
    return <div className={styles.automationscomponent}><p className={styles.subtitle}>Loading automations...</p></div>;
  }

  if (error) {
    return <div className={styles.automationscomponent}><p className={styles.errorText}>{error}</p></div>;
  }

  return (
    <div className={styles.automationscomponent}>
      <div className={styles.banner}>
        <img src={AutomationsBanner} alt="" className={styles.bannerImage} />
        <div className={styles.bannerOverlay} />
        <div className={styles.bannerText}>
          <h2 className={styles.title}>Automations</h2>
          <p className={styles.bannerSubtitle}>
            Reward real work automatically. Connect the tools where work happens, set how many
            sats each event pays, and Zaplie sends the reward the moment it happens.
          </p>
        </div>
      </div>

      {stats && (
        <div className={styles.statPanel}>
          <div className={styles.statHero}>
            <span className={styles.statHeroLabel}>Total automated</span>
            <span className={styles.statHeroValue}>
              {new Intl.NumberFormat('en-US').format(stats.paidSatsThisMonth)}
              <span className={styles.statHeroUnit}> sats</span>
            </span>
            <span className={styles.statHeroSub}>this month</span>
          </div>
          <div className={styles.statRows}>
            <div className={styles.statRow}>
              <span className={styles.statRowLabel}>Automated payments</span>
              <span className={styles.statRowValue}>{stats.paymentsThisMonth}</span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statRowLabel}>Reward rules</span>
              <span className={styles.statRowValue}>
                {RULE_ORDER.filter(key => key in amounts).length}
              </span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statRowLabel}>Active connections</span>
              <span className={styles.statRowValue}>
                {(appInstalled ? 1 : 0) + (webhookKeys.some(k => !k.revokedAt) ? 1 : 0) + 1}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className={styles.steps}>
        <div className={styles.step}>
          <span className={styles.stepNum}>1</span>
          <span className={styles.stepText}>
            Connect a source below, like GitHub or a business flow.
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
            Teammates link their accounts once in Settings, then rewards land in their wallet.
          </span>
        </div>
      </div>

      <h3 className={styles.sectionHeading}>Connections</h3>
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
            Install the Zaplie GitHub App and pick the repositories to watch. Pull requests,
            issues and reviews in those repositories pay sats automatically.
          </p>
          {setupStatus?.created && (
            <span className={styles.connHint}>
              App created as {setupStatus.slug} via the manifest flow. All credentials were
              exchanged server to server.
            </span>
          )}
          {!setupStatus?.created && appInstalled && repos.length === 0 && (
            <span className={styles.connHint}>
              Installed on GitHub. Syncing the repository list needs the App private key on the
              server; add repositories manually meanwhile.
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
              {!setupStatus?.created && (
                <button
                  className={styles.installButton}
                  onClick={handleCreateApp}
                  disabled={creatingApp}
                >
                  {creatingApp ? 'Redirecting to GitHub...' : 'Create the Zaplie GitHub App'}
                </button>
              )}
              <button className={styles.installButton} onClick={handleInstallApp} disabled={installing}>
                {installing
                  ? 'Redirecting to GitHub...'
                  : repos.length > 0
                    ? 'Configure repositories'
                    : 'Connect repositories'}
              </button>
              <details className={styles.manualAdd}>
                <summary className={styles.manualAddSummary}>Add manually</summary>
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
                  <button className={styles.addButton} onClick={handleAddRepo} disabled={saving}>
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
              <span className={styles.connName}>Power Automate and Logic Apps</span>
              <span className={styles.connStatus}>
                {webhookKeys.some(k => !k.revokedAt)
                  ? `${webhookKeys.filter(k => !k.revokedAt).length} active ${webhookKeys.filter(k => !k.revokedAt).length === 1 ? 'key' : 'keys'}`
                  : 'Available today'}
              </span>
            </div>
          </div>
          <p className={styles.connDescription}>
            Business flows such as timesheet completion or approvals POST to the rewards
            endpoint with an API key you create here. Sample flow in docs/automation.
          </p>
          {isAdmin && (
            <>
              {webhookKeys.filter(k => !k.revokedAt).length > 0 && (
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
                    <button className={styles.cardEditButton} onClick={() => setCreatedKey(null)}>
                      Done
                    </button>
                  </div>
                </div>
              )}
              <div className={styles.addRow}>
                <input
                  type="text"
                  placeholder='Key label, like "Timesheet flow"'
                  value={newKeyLabel}
                  onChange={e => setNewKeyLabel(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateKey()}
                  className={styles.addInput}
                  disabled={creatingKey}
                />
                <button className={styles.addButton} onClick={handleCreateKey} disabled={creatingKey}>
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
            Calendar and people signals from Microsoft Graph already power Your week and the
            assistant's suggestions. Shared inbox digests are next.
          </p>
        </div>

        <div className={styles.connCard}>
          <div className={styles.connCardHead}>
            <span className={styles.cardBadge}>
              <img src={ClockIcon} alt="" />
            </span>
            <div className={styles.connCardTitle}>
              <span className={styles.connName}>Timesheets and CRM</span>
              <span className={styles.connStatus}>Via API key today</span>
            </div>
          </div>
          <p className={styles.connDescription}>
            Any system that can call a webhook, like a timesheet app or CRM, rewards teammates
            today using a flow API key. Native connectors are on the roadmap.
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
            A Slack agent with the same recognition model, for teams outside Microsoft Teams.
          </p>
        </div>
      </div>

      <h3 className={styles.sectionHeading}>Reward rules</h3>
      <div className={styles.section}>
        {RULE_ORDER.filter(key => key in amounts).map(key => {
          const meta = RULE_META[key];
          const isEditing = editingKey === key;
          return (
            <div key={key} className={styles.ruleRow}>
              <img src={meta.photo} alt="" className={styles.rulePhoto} />
              <span className={styles.cardBadge}>
                <img src={meta.icon} alt="" />
              </span>
              <div className={styles.ruleInfo}>
                <span className={styles.ruleTitle}>{meta.title}</span>
                <span className={styles.ruleSentence}>{meta.sentence(amounts[key])}</span>
              </div>
              {isEditing ? (
                <input
                  type="number"
                  value={editingValue}
                  onChange={e => setEditingValue(e.target.value)}
                  className={styles.satsInput}
                  autoFocus
                />
              ) : (
                <span className={styles.satsChip}>
                  <img src={ZapIcon} alt="" />
                  {amounts[key]} sats
                </span>
              )}
              {isAdmin &&
                (isEditing ? (
                  <button className={styles.cardSaveButton} onClick={() => handleSaveAmount(key)}>
                    Save
                  </button>
                ) : (
                  <button className={styles.cardEditButton} onClick={() => handleStartEdit(key)}>
                    Edit
                  </button>
                ))}
            </div>
          );
        })}

        <div className={`${styles.ruleRow} ${styles.ruleRowMuted}`}>
          <span className={styles.comingSoonBadge}>Coming soon</span>
          <div className={styles.ruleInfo}>
            <span className={styles.ruleTitle}>Streak bonus</span>
            <span className={styles.ruleSentence}>
              Aggregate rules that reward sustained activity, like five merged pull requests in
              a week.
            </span>
          </div>
        </div>
      </div>

      <ToastContainer />
    </div>
  );
};

export default AutomationsComponent;
