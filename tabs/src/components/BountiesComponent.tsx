import React, { FunctionComponent, useEffect, useState } from 'react';
import axios from 'axios';
import { useMsal } from '@azure/msal-react';
import styles from './BountiesComponent.module.css';
import ZapIcon from '../images/ZapIcon.svg';
import BountiesBanner from '../images/bounties-banner.webp';
import { acquireIdToken, isZaplieAdmin } from '../services/adminRole';
import {
  Bounty,
  getBounties,
  createBounty,
  submitToBounty,
  toggleBountyObjective,
  payBounty,
  cancelBounty,
} from '../services/bountiesService';
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import AchievementsSection from './AchievementsSection';

const STATUS_LABELS: Record<Bounty['status'], string> = {
  open: 'Open',
  claimed: 'Claimed',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

const BountiesComponent: FunctionComponent = () => {
  const { instance, accounts } = useMsal();
  const isAdmin = isZaplieAdmin(accounts[0]);

  const [bounties, setBounties] = useState<Bounty[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [difficulty, setDifficulty] = useState<
    'easy' | 'intermediate' | 'high'
  >('intermediate');
  const [category, setCategory] = useState('Task');
  const [deadlineDays, setDeadlineDays] = useState('');
  const [creating, setCreating] = useState(false);
  const [submitFor, setSubmitFor] = useState<string | null>(null);
  const [submitNote, setSubmitNote] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const myOid = accounts[0]?.localAccountId;
  const idToken = () => acquireIdToken(instance, accounts[0]);

  useEffect(() => {
    if (!accounts[0]) {
      setLoading(false);
      return;
    }
    const load = async () => {
      try {
        setBounties(await getBounties(await idToken()));
      } catch (error) {
        console.error('Error fetching bounties:', error);
        toast.error('Could not load bounties.');
      } finally {
        setLoading(false);
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, instance]);

  const replaceBounty = (updated: Bounty) =>
    setBounties(previous =>
      previous.map(b => (b.id === updated.id ? updated : b)),
    );

  const handleCreate = async () => {
    const amountSats = Number(amount);
    if (
      !title.trim() ||
      !description.trim() ||
      !Number.isInteger(amountSats) ||
      amountSats <= 0
    ) {
      toast.error(
        'A bounty needs a title, a description and a whole amount of sats.',
      );
      return;
    }
    const days = Number(deadlineDays);
    if (deadlineDays && (!Number.isInteger(days) || days <= 0)) {
      toast.error('The deadline must be a whole number of days.');
      return;
    }
    setCreating(true);
    try {
      const created = await createBounty(await idToken(), {
        title: title.trim(),
        description: description.trim(),
        amountSats,
        difficulty,
        category: category.trim() || undefined,
        deadlineDays: deadlineDays ? days : undefined,
      });
      setBounties(previous => [created, ...previous]);
      setTitle('');
      setDescription('');
      setAmount('');
      setDeadlineDays('');
      toast.success('Bounty published.');
    } catch (error) {
      console.error('Error creating bounty:', error);
      toast.error('Could not publish the bounty.');
    } finally {
      setCreating(false);
    }
  };

  const run = async (
    id: string,
    action: (token: string) => Promise<Bounty>,
    okMessage: string,
  ) => {
    setBusyId(id);
    try {
      replaceBounty(await action(await idToken()));
      toast.success(okMessage);
    } catch (error) {
      console.error('Bounty action failed:', error);
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      if (status === 402) {
        toast.error('The treasury balance is not enough for this bounty.');
      } else if (status === 409) {
        toast.error(
          'Someone got there first. Refresh to see the latest state.',
        );
      } else {
        toast.error('The action failed. Please try again.');
      }
    } finally {
      setBusyId(null);
    }
  };

  const visible = bounties.filter(b => b.status !== 'cancelled');
  const openCount = visible.filter(b => b.status === 'open').length;

  if (loading) {
    return (
      <div className={styles.bountiescomponent}>
        <p className={styles.subtitle}>Loading bounties...</p>
      </div>
    );
  }

  return (
    <div className={styles.bountiescomponent}>
      <div className={styles.banner}>
        <img src={BountiesBanner} alt="" className={styles.bannerImage} />
        <div className={styles.bannerOverlay} />
        <div className={styles.bannerText}>
          <h2 className={styles.title}>Bounties</h2>
          <p className={styles.subtitle}>
            Open tasks with a sat prize. Claim one, ship it, and the treasury
            pays you directly.
          </p>
        </div>
      </div>

      {isAdmin && (
        <div className={styles.createCard}>
          <span className={styles.createHeading}>Publish a bounty</span>
          <div className={styles.createRow}>
            <input
              type="text"
              placeholder="Title, like Fix the flaky login test"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className={styles.input}
              disabled={creating}
            />
            <input
              type="number"
              placeholder="Sats"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className={`${styles.input} ${styles.amountInput}`}
              disabled={creating}
            />
          </div>
          <textarea
            placeholder="What done looks like, in one or two sentences."
            value={description}
            onChange={e => setDescription(e.target.value)}
            className={styles.textarea}
            rows={2}
            disabled={creating}
          />
          <div className={styles.createRow}>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className={styles.select}
              disabled={creating}
            >
              <option value="Task">Task</option>
              <option value="Achievement">Achievement</option>
              <option value="Certification">Certification</option>
            </select>
            <select
              value={difficulty}
              onChange={e =>
                setDifficulty(
                  e.target.value as 'easy' | 'intermediate' | 'high',
                )
              }
              className={styles.select}
              disabled={creating}
            >
              <option value="easy">Easy difficulty</option>
              <option value="intermediate">Intermediate difficulty</option>
              <option value="high">High difficulty</option>
            </select>
            <input
              type="number"
              placeholder="Deadline in days (optional)"
              value={deadlineDays}
              onChange={e => setDeadlineDays(e.target.value)}
              className={styles.input}
              disabled={creating}
            />
          </div>
          <button
            className={styles.primaryButton}
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? 'Publishing...' : 'Publish bounty'}
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <p className={styles.emptyText}>
          No bounties yet.
          {isAdmin ? ' Publish the first one above.' : ' Check back soon.'}
        </p>
      ) : (
        <div className={styles.list}>
          {visible.map(bounty => (
            <div key={bounty.id} className={styles.row}>
              <div className={styles.rowInfo}>
                <div className={styles.rowTitleLine}>
                  <span className={styles.rowTitle}>{bounty.title}</span>
                  <span
                    className={`${styles.statusBadge} ${styles[`status_${bounty.status}`]}`}
                  >
                    {STATUS_LABELS[bounty.status]}
                  </span>
                </div>
                <span className={styles.rowDescription}>
                  {bounty.description}
                </span>
                <span className={styles.rowMeta}>
                  {bounty.category || 'Task'} ·{' '}
                  {bounty.difficulty || 'intermediate'} difficulty
                  {bounty.deadlineAt &&
                    (() => {
                      const daysLeft = Math.ceil(
                        (Date.parse(bounty.deadlineAt) - Date.now()) / 86400000,
                      );
                      return daysLeft > 0
                        ? ` · ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} remaining`
                        : ' · deadline passed';
                    })()}
                  {' · '}
                  {bounty.submissions.length}{' '}
                  {bounty.submissions.length === 1
                    ? 'submission'
                    : 'submissions'}
                </span>
                {bounty.claimantName && (
                  <span className={styles.rowMeta}>
                    {bounty.status === 'paid' ? 'Completed by' : 'Claimed by'}{' '}
                    {bounty.claimantName}
                  </span>
                )}
                {bounty.submissions.length > 0 && bounty.status !== 'paid' && (
                  <button
                    className={styles.linkButton}
                    onClick={() =>
                      setExpandedId(expandedId === bounty.id ? null : bounty.id)
                    }
                  >
                    {expandedId === bounty.id
                      ? 'Hide submissions'
                      : 'View submissions'}
                  </button>
                )}
                {expandedId === bounty.id && bounty.status !== 'paid' && (
                  <div className={styles.submissionList}>
                    {bounty.submissions.map(submission => (
                      <div key={submission.id} className={styles.submissionRow}>
                        <div className={styles.submissionInfo}>
                          <span className={styles.submissionName}>
                            {submission.name}
                          </span>
                          <span className={styles.submissionNote}>
                            {submission.note}
                          </span>
                        </div>
                        {isAdmin && bounty.status === 'open' && (
                          <button
                            className={styles.primaryButton}
                            disabled={busyId === bounty.id}
                            onClick={() =>
                              run(
                                bounty.id,
                                t => payBounty(t, bounty.id, submission.id),
                                `Paid ${bounty.amountSats} sats to ${submission.name}.`,
                              )
                            }
                          >
                            {busyId === bounty.id
                              ? 'Paying...'
                              : 'Pay this one'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {submitFor === bounty.id && (
                  <div className={styles.submitBox}>
                    <textarea
                      placeholder="What you did and where to see it, like a PR link."
                      value={submitNote}
                      onChange={e => setSubmitNote(e.target.value)}
                      className={styles.textarea}
                      rows={2}
                      maxLength={500}
                    />
                    <div className={styles.rowActions}>
                      <button
                        className={styles.primaryButton}
                        disabled={busyId === bounty.id || !submitNote.trim()}
                        onClick={async () => {
                          await run(
                            bounty.id,
                            t =>
                              submitToBounty(t, bounty.id, submitNote.trim()),
                            'Submission sent. Good luck!',
                          );
                          setSubmitFor(null);
                          setSubmitNote('');
                        }}
                      >
                        Send submission
                      </button>
                      <button
                        className={styles.secondaryButton}
                        onClick={() => {
                          setSubmitFor(null);
                          setSubmitNote('');
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <span className={styles.satsChip}>
                <img src={ZapIcon} alt="" />
                {new Intl.NumberFormat('en-US').format(bounty.amountSats)} sats
              </span>
              <div className={styles.rowActions}>
                {bounty.status === 'open' &&
                  !bounty.submissions.some(s => s.aad === myOid) &&
                  submitFor !== bounty.id && (
                    <button
                      className={styles.primaryButton}
                      disabled={busyId === bounty.id}
                      onClick={() => {
                        setSubmitFor(bounty.id);
                        setSubmitNote('');
                      }}
                    >
                      Submit work
                    </button>
                  )}
                {bounty.status === 'open' && (
                  <button
                    className={
                      bounty.objectives.some(o => o.aad === myOid)
                        ? styles.objectiveSetButton
                        : styles.secondaryButton
                    }
                    disabled={busyId === bounty.id}
                    onClick={() =>
                      run(
                        bounty.id,
                        t => toggleBountyObjective(t, bounty.id),
                        bounty.objectives.some(o => o.aad === myOid)
                          ? 'Removed from your objectives.'
                          : 'Set as one of your objectives.',
                      )
                    }
                  >
                    {bounty.objectives.some(o => o.aad === myOid)
                      ? 'Objective set'
                      : 'Set as objective'}
                  </button>
                )}
                {isAdmin && bounty.status === 'claimed' && (
                  <button
                    className={styles.primaryButton}
                    disabled={busyId === bounty.id}
                    onClick={() =>
                      run(
                        bounty.id,
                        t => payBounty(t, bounty.id),
                        `Paid ${bounty.amountSats} sats to ${bounty.claimantName}.`,
                      )
                    }
                  >
                    {busyId === bounty.id ? 'Paying...' : 'Pay'}
                  </button>
                )}
                {isAdmin && bounty.status === 'open' && (
                  <button
                    className={styles.secondaryButton}
                    disabled={busyId === bounty.id}
                    onClick={() =>
                      run(
                        bounty.id,
                        t => cancelBounty(t, bounty.id),
                        'Bounty cancelled.',
                      )
                    }
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {visible.length > 0 && (
        <span className={styles.footerNote}>
          {openCount} open {openCount === 1 ? 'bounty' : 'bounties'}
        </span>
      )}

      <AchievementsSection />
    </div>
  );
};

export default BountiesComponent;
