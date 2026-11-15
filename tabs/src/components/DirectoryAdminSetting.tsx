import React, {
  FunctionComponent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { useMsal } from '@azure/msal-react';
import styles from './setting.module.css';
import { isZaplieAdmin } from '../services/adminRole';
import {
  DirectoryAdminView,
  DirectoryPerson,
  linkAllowanceWallet,
  listDirectoryPeople,
  ProvisionPeriod,
  ProvisionResult,
  provisionPeople,
} from '../services/directory';

const OID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_BUDGET_SATS = 25000;

type Mode = 'provisioner' | 'manual';

interface Candidate {
  oid: string;
  displayName: string;
}

interface ManualLink {
  nwcUrl: string;
  lightningAddress: string;
}

const statusLabel: Record<ProvisionResult['status'], string> = {
  provisioned: 'Set up',
  'already-linked': 'Already set up',
  failed: 'Failed',
};

// Zaplie.Admin only (the backend enforces it regardless). Lists who has an
// Allowance wallet and where they receive, and onboards people:
//   * provisioner mode - the backend creates each wallet, its NWC connection
//     (with the budget) and its pay link, using a short-lived token pasted
//     here for this one request and never kept;
//   * manual mode - paste each wallet's NWC connection and Lightning
//     address, for any wallet backend.
// Connections and tokens are sent once and never shown back.
const DirectoryAdminSetting: FunctionComponent = () => {
  const { accounts } = useMsal();
  const isAdmin = isZaplieAdmin(accounts[0]);
  const [view, setView] = useState<DirectoryAdminView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setView(await listDirectoryPeople());
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : 'The directory is unavailable.',
      );
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) return null;

  const pending = (view?.people || []).filter(
    person => !person.allowanceWalletId,
  );

  return (
    <section className={styles.section} aria-labelledby="directory-heading">
      <div className={styles.sectionHeader}>
        <h2 id="directory-heading" className={styles.heading}>
          People and Allowance wallets
        </h2>
        <p className={styles.intro}>
          Each person zaps from an Allowance wallet that Zaplie reaches only
          through a Nostr Wallet Connect connection with a budget. Zaps go only
          to other people listed here, at the Lightning address they registered.
        </p>
      </div>
      <div className={styles.card}>
        {loadError ? (
          <p className={styles.errorText} role="alert">
            {loadError}
          </p>
        ) : null}
        {view ? (
          <table aria-label="People in the Zaplie directory">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Allowance wallet</th>
                <th scope="col">Receives at</th>
              </tr>
            </thead>
            <tbody>
              {view.people.map(person => (
                <tr key={person.oid}>
                  <td title={person.oid}>{person.displayName}</td>
                  <td>
                    {person.allowanceWalletId
                      ? person.allowanceLightningAddress || 'linked'
                      : 'not set up'}
                  </td>
                  <td>{person.receive.lightningAddress || 'not set up'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => setDialogOpen(true)}
          disabled={!view}
        >
          Add people
        </button>
      </div>
      {dialogOpen && view ? (
        <AddPeopleDialog
          pending={pending}
          provisioners={view.provisioners}
          onClose={() => {
            setDialogOpen(false);
            void load();
          }}
        />
      ) : null}
    </section>
  );
};

const AddPeopleDialog: FunctionComponent<{
  pending: DirectoryPerson[];
  provisioners: string[];
  onClose: () => void;
}> = ({ pending, provisioners, onClose }) => {
  const canProvision = provisioners.includes('lnbits');
  const [mode, setMode] = useState<Mode>(
    canProvision ? 'provisioner' : 'manual',
  );
  const [candidates, setCandidates] = useState<Candidate[]>(
    pending.map(person => ({
      oid: person.oid,
      displayName: person.displayName,
    })),
  );
  const [selected, setSelected] = useState<Set<string>>(
    new Set(pending.map(person => person.oid)),
  );
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

  const toggle = (oid: string) =>
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(oid)) next.delete(oid);
      else next.add(oid);
      return next;
    });

  const addCandidate = () => {
    const oid = newOid.trim().toLowerCase();
    if (!OID_PATTERN.test(oid) || candidates.some(c => c.oid === oid)) return;
    setCandidates([...candidates, { oid, displayName: newName.trim() || oid }]);
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

  return (
    <div className="overlay" role="presentation">
      <div
        className={`popup ${styles.card}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-people-heading"
      >
        <h3 id="add-people-heading" className={styles.heading}>
          Add people
        </h3>

        <fieldset>
          <legend className={styles.fieldLabel}>Who</legend>
          {candidates.length === 0 ? (
            <p className={styles.intro}>
              Nobody is waiting. People appear here once they message the bot or
              sign in; or add someone by Entra object id.
            </p>
          ) : null}
          {candidates.map(candidate => (
            <label key={candidate.oid} className={styles.fieldLabel}>
              <input
                type="checkbox"
                checked={selected.has(candidate.oid)}
                onChange={() => toggle(candidate.oid)}
                disabled={busy}
              />{' '}
              {candidate.displayName}
            </label>
          ))}
          <div className={styles.inputRow}>
            <input
              aria-label="Entra object id"
              className={`${styles.textBox} ${styles.editing}`}
              placeholder="Entra object id"
              value={newOid}
              onChange={event => setNewOid(event.target.value)}
              disabled={busy}
            />
            <input
              aria-label="Display name"
              className={`${styles.textBox} ${styles.editing}`}
              placeholder="Display name"
              value={newName}
              onChange={event => setNewName(event.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={addCandidate}
              disabled={busy || !OID_PATTERN.test(newOid.trim())}
            >
              Add to list
            </button>
          </div>
        </fieldset>

        <fieldset>
          <legend className={styles.fieldLabel}>How</legend>
          <label className={styles.fieldLabel}>
            <input
              type="radio"
              name="add-people-mode"
              checked={mode === 'provisioner'}
              onChange={() => setMode('provisioner')}
              disabled={!canProvision || busy}
            />{' '}
            Create the wallets in LNbits for me
          </label>
          <label className={styles.fieldLabel}>
            <input
              type="radio"
              name="add-people-mode"
              checked={mode === 'manual'}
              onChange={() => setMode('manual')}
              disabled={busy}
            />{' '}
            Paste each wallet&apos;s NWC connection (any wallet)
          </label>
        </fieldset>

        {mode === 'provisioner' ? (
          <div data-testid="provisioner-mode">
            <p className={styles.intro}>
              Paste a short-lived LNbits access token of the zaplie.service
              account (expires today; read on /api/v1/wallets, write on
              /api/v1/wallet). Zaplie uses it for this one request to create
              each wallet, its NWC connection with the budget below and its
              zaplie- pay link, and never keeps it.
            </p>
            <label className={styles.fieldLabel} htmlFor="provision-token">
              LNbits access token
            </label>
            <input
              id="provision-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className={`${styles.textBox} ${styles.editing}`}
              value={token}
              onChange={event => setToken(event.target.value)}
              disabled={busy}
            />
            <div className={styles.inputRow}>
              <label className={styles.fieldLabel} htmlFor="provision-budget">
                Budget (sats per period)
              </label>
              <input
                id="provision-budget"
                type="number"
                min={1}
                className={`${styles.textBox} ${styles.editing}`}
                value={budgetSats}
                onChange={event => setBudgetSats(event.target.value)}
                disabled={busy}
              />
              <label className={styles.fieldLabel} htmlFor="provision-period">
                Period
              </label>
              <select
                id="provision-period"
                value={period}
                onChange={event =>
                  setPeriod(event.target.value as ProvisionPeriod)
                }
                disabled={busy}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          </div>
        ) : (
          <div data-testid="manual-mode">
            <p className={styles.intro}>
              For each person, create an NWC connection on their Allowance
              wallet (permissions: pay, invoice, lookup, history, balance, info;
              budget = the allowance cap) and paste it with the wallet&apos;s
              own Lightning address. Zaplie connects to check it before saving.
            </p>
            {chosen.map(({ oid, displayName }) => (
              <div key={oid} className={styles.inputRow}>
                <span className={styles.fieldLabel}>{displayName}</span>
                <input
                  aria-label={`NWC connection for ${displayName}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className={`${styles.textBox} ${styles.editing}`}
                  placeholder="nostr+walletconnect://…"
                  value={manual[oid]?.nwcUrl || ''}
                  onChange={event =>
                    setLink(oid, { nwcUrl: event.target.value })
                  }
                  disabled={busy}
                />
                <input
                  aria-label={`Lightning address for ${displayName}`}
                  className={`${styles.textBox} ${styles.editing}`}
                  placeholder="zaplie-…@your-lnbits-host"
                  value={manual[oid]?.lightningAddress || ''}
                  onChange={event =>
                    setLink(oid, { lightningAddress: event.target.value })
                  }
                  disabled={busy}
                />
              </div>
            ))}
          </div>
        )}

        {error ? (
          <p className={styles.errorText} role="alert">
            {error}
          </p>
        ) : null}

        {results ? (
          <table aria-label="Add people results">
            <tbody>
              {results.map(result => (
                <tr key={result.oid} data-status={result.status}>
                  <td>{result.displayName || result.oid}</td>
                  <td>{statusLabel[result.status]}</td>
                  <td>{result.lightningAddress || result.message || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        <div className={styles.inputRow}>
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
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default DirectoryAdminSetting;
