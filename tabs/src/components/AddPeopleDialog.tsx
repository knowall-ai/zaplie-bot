import React, { FunctionComponent, useId, useMemo, useState } from 'react';
import styles from './setting.module.css';
import Modal from './Modal';
import SecretInput from './SecretInput';
import {
  DirectoryPerson,
  linkAllowanceWallet,
  ProvisionPeriod,
  ProvisionResult,
  provisionPeople,
} from '../services/directory';

const OID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_BUDGET_SATS = 25000;
export const RUNBOOK_ONBOARDING_URL =
  'https://github.com/knowall-ai/zaplie-bot/blob/main/docs/LNBITS_MIGRATION.adoc#onboarding';

type Mode = 'provisioner' | 'manual';

interface Candidate {
  oid: string;
  displayName: string;
  email: string;
}

interface ManualLink {
  nwcUrl: string;
  lightningAddress: string;
}

const statusPill: Record<
  ProvisionResult['status'],
  { label: string; className: string }
> = {
  provisioned: { label: 'Set up', className: styles.pillOk },
  'already-linked': { label: 'Already set up', className: styles.pill },
  failed: { label: 'Failed', className: styles.pillDanger },
};

// Onboards people who have no Allowance wallet yet, in one of two ways:
//   * provisioner mode - the backend creates each wallet, its NWC connection
//     (with the budget) and its pay link, using a short-lived token pasted
//     here for this one request and never kept;
//   * manual mode - paste each wallet's NWC connection and Lightning
//     address, for any wallet backend.
// Connections and tokens are sent once and never shown back.
const AddPeopleDialog: FunctionComponent<{
  pending: DirectoryPerson[];
  provisioners: string[];
  onClose: () => void;
}> = ({ pending, provisioners, onClose }) => {
  const ids = useId();
  const canProvision = provisioners.includes('lnbits');
  const [mode, setMode] = useState<Mode>(
    canProvision ? 'provisioner' : 'manual',
  );
  const [candidates, setCandidates] = useState<Candidate[]>(
    pending.map(({ oid, displayName, email }) => ({
      oid,
      displayName,
      email,
    })),
  );
  const [selected, setSelected] = useState<Set<string>>(
    new Set(pending.map(person => person.oid)),
  );
  const [search, setSearch] = useState('');
  const [newOid, setNewOid] = useState('');
  const [newName, setNewName] = useState('');
  const [token, setToken] = useState('');
  const [budgetSats, setBudgetSats] = useState(String(DEFAULT_BUDGET_SATS));
  const [period, setPeriod] = useState<ProvisionPeriod>('weekly');
  const [manual, setManual] = useState<Record<string, ManualLink>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ProvisionResult[] | null>(null);

  const chosen = candidates.filter(candidate => selected.has(candidate.oid));
  const budget = Number.parseInt(budgetSats, 10);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return candidates;
    return candidates.filter(
      candidate =>
        candidate.displayName.toLowerCase().includes(query) ||
        candidate.email.toLowerCase().includes(query),
    );
  }, [candidates, search]);

  const toggle = (oid: string) =>
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(oid)) next.delete(oid);
      else next.add(oid);
      return next;
    });

  const newOidValid = OID_PATTERN.test(newOid.trim());
  const addCandidate = () => {
    const oid = newOid.trim().toLowerCase();
    if (!OID_PATTERN.test(oid) || candidates.some(c => c.oid === oid)) return;
    setCandidates([
      ...candidates,
      { oid, displayName: newName.trim() || oid, email: '' },
    ]);
    setSelected(previous => new Set(Array.from(previous).concat(oid)));
    setNewOid('');
    setNewName('');
  };

  const setLink = (oid: string, patch: Partial<ManualLink>) =>
    setManual(previous => ({
      ...previous,
      [oid]: {
        nwcUrl: previous[oid]?.nwcUrl ?? '',
        lightningAddress: previous[oid]?.lightningAddress ?? '',
        ...patch,
      },
    }));

  const runProvisioner = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await provisionPeople({
        provisioner: 'lnbits',
        token: token.trim(),
        people: chosen.map(({ oid, displayName }) => ({ oid, displayName })),
        budgetSats: budget,
        period,
      });
      setResults(response.results);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Provisioning failed.',
      );
    } finally {
      // The token is for this one request: forget it whatever happened.
      setToken('');
      setBusy(false);
    }
  };

  const runManual = async () => {
    setBusy(true);
    setError(null);
    const outcome: ProvisionResult[] = [];
    for (const { oid, displayName } of chosen) {
      const link = manual[oid];
      try {
        const { person } = await linkAllowanceWallet(oid, {
          nwcUrl: (link?.nwcUrl || '').trim(),
          ...(link?.lightningAddress?.trim()
            ? { lightningAddress: link.lightningAddress.trim() }
            : {}),
          displayName,
        });
        outcome.push({
          oid,
          displayName,
          status: 'provisioned',
          lightningAddress: person.allowanceLightningAddress || undefined,
        });
      } catch (caught) {
        outcome.push({
          oid,
          displayName,
          status: 'failed',
          message: caught instanceof Error ? caught.message : 'Linking failed.',
        });
      }
    }
    // Connection strings are sent once: clear them from the form.
    setManual({});
    setResults(outcome);
    setBusy(false);
  };

  const canRunProvisioner =
    !busy &&
    chosen.length > 0 &&
    token.trim().length >= 16 &&
    Number.isSafeInteger(budget) &&
    budget > 0;
  const canRunManual =
    !busy &&
    chosen.length > 0 &&
    chosen.every(({ oid }) => manual[oid]?.nwcUrl?.trim());

  const footer = (
    <>
      <button
        type="button"
        className={styles.secondaryButton}
        onClick={onClose}
        disabled={busy}
      >
        {results ? 'Done' : 'Cancel'}
      </button>
      {mode === 'provisioner' ? (
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!canRunProvisioner}
          onClick={() => void runProvisioner()}
        >
          {busy ? 'Creating…' : 'Create wallets'}
        </button>
      ) : (
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!canRunManual}
          onClick={() => void runManual()}
        >
          {busy ? 'Linking…' : 'Link wallets'}
        </button>
      )}
    </>
  );

  return (
    <Modal
      title="Add people"
      onClose={onClose}
      dismissable={!busy}
      footer={footer}
    >
      <fieldset className={styles.fieldset} disabled={busy}>
        <legend className={styles.legend}>
          Who{' '}
          <span className={styles.secondaryLine}>
            People waiting for an Allowance wallet. Someone appears here once
            they message the Zaplie bot or sign in to the portal.
          </span>
        </legend>
        {candidates.length > 0 ? (
          <input
            type="search"
            aria-label="Search people"
            className={`${styles.textBox} ${styles.editing}`}
            placeholder="Search by name or email"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        ) : null}
        <ul className={styles.pickList} aria-label="People to add">
          {visible.length === 0 ? (
            <li className={styles.pickEmpty}>
              {candidates.length === 0
                ? 'Nobody is waiting for an Allowance wallet.'
                : 'Nobody matches that search.'}
            </li>
          ) : (
            visible.map(candidate => (
              <li key={candidate.oid} className={styles.pickItem}>
                <label title={candidate.oid}>
                  <input
                    type="checkbox"
                    checked={selected.has(candidate.oid)}
                    onChange={() => toggle(candidate.oid)}
                  />
                  <span>
                    {candidate.displayName}
                    {candidate.email ? (
                      <span className={styles.secondaryLine}>
                        {candidate.email}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))
          )}
        </ul>
        <p className={styles.helperText} aria-live="polite">
          {chosen.length === 1
            ? '1 person selected'
            : `${chosen.length} people selected`}
        </p>
        <details className={styles.advanced}>
          <summary>Add someone who isn&apos;t listed (advanced)</summary>
          <div className={styles.fieldGrid}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={`${ids}-oid`}>
                Entra object id
              </label>
              <input
                id={`${ids}-oid`}
                className={`${styles.textBox} ${styles.editing}`}
                placeholder="00000000-0000-0000-0000-000000000000"
                spellCheck={false}
                value={newOid}
                onChange={event => setNewOid(event.target.value)}
                aria-invalid={newOid.trim() !== '' && !newOidValid}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={`${ids}-name`}>
                Display name
              </label>
              <input
                id={`${ids}-name`}
                className={`${styles.textBox} ${styles.editing}`}
                value={newName}
                onChange={event => setNewName(event.target.value)}
              />
            </div>
          </div>
          <p className={styles.helperText}>
            Find the object id in Entra under Users → the person → Overview.
          </p>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={addCandidate}
            disabled={!newOidValid}
          >
            Add to list
          </button>
        </details>
      </fieldset>

      <fieldset className={styles.fieldset} disabled={busy}>
        <legend className={styles.legend}>How</legend>
        <label
          className={styles.option}
          data-checked={mode === 'provisioner'}
          data-disabled={!canProvision}
        >
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={mode === 'provisioner'}
            onChange={() => setMode('provisioner')}
            disabled={!canProvision}
          />
          <span className={styles.optionTitle}>
            Create the wallets in LNbits for me
          </span>
          <span className={styles.optionHint}>
            {canProvision
              ? 'Recommended. Zaplie creates each wallet, its spending budget and its Lightning address in one go.'
              : 'Not available on this deployment.'}
          </span>
        </label>
        <label className={styles.option} data-checked={mode === 'manual'}>
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={mode === 'manual'}
            onChange={() => setMode('manual')}
          />
          <span className={styles.optionTitle}>
            Paste each wallet&apos;s NWC connection
          </span>
          <span className={styles.optionHint}>
            For wallets you have already created, on LNbits or any other wallet
            that supports Nostr Wallet Connect.
          </span>
        </label>
      </fieldset>

      {mode === 'provisioner' ? (
        <fieldset
          className={styles.fieldset}
          disabled={busy}
          data-testid="provisioner-mode"
        >
          <legend className={styles.legend}>LNbits access</legend>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="provision-token">
              LNbits access token
            </label>
            <SecretInput
              id="provision-token"
              value={token}
              onChange={setToken}
              describedBy={`${ids}-token-help`}
            />
            <p id={`${ids}-token-help`} className={styles.helperText}>
              Create a token on the zaplie.service account that can list and
              create wallets, and that expires today. Zaplie uses it for this
              one request only and never stores it.{' '}
              <a
                className={styles.link}
                href={RUNBOOK_ONBOARDING_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                How to create the token
              </a>
            </p>
          </div>
          <div className={styles.fieldGrid}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="provision-budget">
                Budget (sats per period)
              </label>
              <input
                id="provision-budget"
                type="number"
                min={1}
                inputMode="numeric"
                className={`${styles.textBox} ${styles.editing}`}
                value={budgetSats}
                onChange={event => setBudgetSats(event.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="provision-period">
                Period
              </label>
              <select
                id="provision-period"
                className={styles.select}
                value={period}
                onChange={event =>
                  setPeriod(event.target.value as ProvisionPeriod)
                }
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          </div>
        </fieldset>
      ) : (
        <fieldset
          className={styles.fieldset}
          disabled={busy}
          data-testid="manual-mode"
        >
          <legend className={styles.legend}>
            Connections{' '}
            <span className={styles.secondaryLine}>
              On each person&apos;s Allowance wallet, create an NWC connection
              with permission to pay, create invoices, look up, read history,
              read the balance and get info, and a budget of the allowance cap.
              Zaplie connects to check it before saving.{' '}
              <a
                className={styles.link}
                href={RUNBOOK_ONBOARDING_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Step-by-step guide
              </a>
            </span>
          </legend>
          {chosen.length === 0 ? (
            <p className={styles.helperText}>Select people above first.</p>
          ) : null}
          {chosen.map(({ oid, displayName }) => (
            <div key={oid} className={styles.field}>
              <span className={styles.primaryCell}>{displayName}</span>
              <div className={styles.fieldGrid}>
                <SecretInput
                  label={`NWC connection for ${displayName}`}
                  placeholder="nostr+walletconnect://…"
                  value={manual[oid]?.nwcUrl || ''}
                  onChange={value => setLink(oid, { nwcUrl: value })}
                />
                <input
                  aria-label={`Lightning address for ${displayName}`}
                  className={`${styles.textBox} ${styles.editing}`}
                  placeholder="Lightning address"
                  spellCheck={false}
                  value={manual[oid]?.lightningAddress || ''}
                  onChange={event =>
                    setLink(oid, { lightningAddress: event.target.value })
                  }
                />
              </div>
            </div>
          ))}
        </fieldset>
      )}

      {error ? (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      ) : null}

      {results ? (
        <div className={styles.tableWrap} role="status">
          <table className={styles.table} aria-label="Add people results">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Result</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {results.map(result => (
                <tr key={result.oid} data-status={result.status}>
                  <td className={styles.primaryCell}>
                    {result.displayName || result.oid}
                  </td>
                  <td>
                    <span className={statusPill[result.status].className}>
                      {statusPill[result.status].label}
                    </span>
                  </td>
                  <td>{result.lightningAddress || result.message || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Modal>
  );
};

export default AddPeopleDialog;
