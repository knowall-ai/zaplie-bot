import React, {
  FunctionComponent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { useMsal } from '@azure/msal-react';
import { toast } from 'react-toastify';
import styles from './setting.module.css';
import { isZaplieAdmin } from '../services/adminRole';
import {
  DirectoryAdminView,
  linkAllowanceWallet,
  listDirectoryPeople,
  provisionAllowanceWallet,
} from '../services/directory';

const OID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Zaplie.Admin only (the backend enforces it regardless). Shows who has an
// Allowance wallet and where they receive, and links an Allowance wallet an
// operator created under zaplie.service in the LNbits UI — the path when no
// LNbits API token is configured. Keys are sent once and never shown back.
const DirectoryAdminSetting: FunctionComponent = () => {
  const { accounts } = useMsal();
  const isAdmin = isZaplieAdmin(accounts[0]);
  const [view, setView] = useState<DirectoryAdminView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [oid, setOid] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [adminkey, setAdminkey] = useState('');
  const [inkey, setInkey] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setActionError(null);
    try {
      toast.success(await action());
      await load();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : 'That did not work. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const link = () =>
    run(async () => {
      const result = await linkAllowanceWallet(oid.trim(), {
        adminkey: adminkey.trim(),
        inkey: inkey.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      setAdminkey('');
      setInkey('');
      return result.ownershipVerified
        ? 'Allowance wallet linked.'
        : 'Allowance wallet linked. Without the API token Zaplie could not confirm zaplie.service owns it: check in LNbits.';
    });

  const canLink =
    !busy && OID_PATTERN.test(oid.trim()) && adminkey.trim() && inkey.trim();

  return (
    <section className={styles.section} aria-labelledby="directory-heading">
      <div className={styles.sectionHeader}>
        <h2 id="directory-heading" className={styles.heading}>
          People and Allowance wallets
        </h2>
        <p className={styles.intro}>
          Every Allowance wallet belongs to the zaplie.service LNbits account.{' '}
          {view?.provisioning === 'automatic'
            ? 'Zaplie creates one when a person first signs in.'
            : 'No LNbits API token is configured, so create each wallet under zaplie.service in LNbits and link it here.'}
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
                <th scope="col">Allowance</th>
                <th scope="col">Receives at</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {view.people.map(person => (
                <tr key={person.oid}>
                  <td title={person.oid}>{person.displayName}</td>
                  <td>
                    {person.allowanceWalletId
                      ? `linked (${person.allowanceSource})`
                      : 'none'}
                  </td>
                  <td>
                    {person.receive.lightningAddress ||
                      (person.receive.invoiceKeyRegistered
                        ? 'invoice key'
                        : 'not set up')}
                  </td>
                  <td>
                    {!person.allowanceWalletId ? (
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        disabled={busy}
                        onClick={() => {
                          if (view.provisioning === 'automatic') {
                            void run(async () => {
                              await provisionAllowanceWallet(person.oid);
                              return `Allowance wallet created for ${person.displayName}.`;
                            });
                          } else {
                            setOid(person.oid);
                            setDisplayName(person.displayName);
                          }
                        }}
                      >
                        {view.provisioning === 'automatic' ? 'Create' : 'Link…'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        <label className={styles.fieldLabel} htmlFor="link-oid">
          Entra object id
        </label>
        <input
          id="link-oid"
          className={`${styles.textBox} ${styles.editing}`}
          value={oid}
          onChange={event => setOid(event.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          disabled={busy}
        />
        <label className={styles.fieldLabel} htmlFor="link-name">
          Display name (for someone who has not signed in yet)
        </label>
        <input
          id="link-name"
          className={`${styles.textBox} ${styles.editing}`}
          value={displayName}
          onChange={event => setDisplayName(event.target.value)}
          disabled={busy}
        />
        <label className={styles.fieldLabel} htmlFor="link-adminkey">
          Allowance wallet admin key
        </label>
        <input
          id="link-adminkey"
          type="password"
          autoComplete="off"
          className={`${styles.textBox} ${styles.editing}`}
          value={adminkey}
          onChange={event => setAdminkey(event.target.value)}
          disabled={busy}
        />
        <label className={styles.fieldLabel} htmlFor="link-inkey">
          Allowance wallet invoice key
        </label>
        <div className={styles.inputRow}>
          <input
            id="link-inkey"
            type="password"
            autoComplete="off"
            className={`${styles.textBox} ${styles.editing}`}
            value={inkey}
            onChange={event => setInkey(event.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!canLink}
            onClick={() => void link()}
          >
            Link wallet
          </button>
        </div>
        {actionError ? (
          <p className={styles.errorText} role="alert">
            {actionError}
          </p>
        ) : null}
      </div>
    </section>
  );
};

export default DirectoryAdminSetting;
