import React, {
  FunctionComponent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { useMsal } from '@azure/msal-react';
import styles from './setting.module.css';
import { isZaplieAdmin } from '../services/adminRole';
import AddPeopleDialog from './AddPeopleDialog';
import { DirectoryAdminView, listDirectoryPeople } from '../services/directory';

const NotSetUp = () => <span className={styles.pill}>Not set up</span>;

// Zaplie.Admin only (the backend enforces it regardless). Lists who has an
// Allowance wallet and where they receive, and opens Add people.
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
          <>
            <div className={styles.cardToolbar}>
              <p className={styles.helperText}>
                {view.people.length === 1
                  ? '1 person'
                  : `${view.people.length} people`}
                {pending.length > 0
                  ? ` · ${pending.length} waiting for an Allowance wallet`
                  : ''}
              </p>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => setDialogOpen(true)}
              >
                Add people
              </button>
            </div>
            <div className={styles.tableWrap}>
              <table
                className={styles.table}
                aria-label="People in the Zaplie directory"
              >
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
                      <td className={styles.primaryCell} title={person.oid}>
                        {person.displayName}
                        {person.email ? (
                          <span className={styles.secondaryLine}>
                            {person.email}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {person.allowanceWalletId ? (
                          person.allowanceLightningAddress || (
                            <span className={styles.pillOk}>Linked</span>
                          )
                        ) : (
                          <NotSetUp />
                        )}
                      </td>
                      <td>{person.receive.lightningAddress || <NotSetUp />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : loadError ? null : (
          <span className={styles.inputSkeleton} aria-busy="true" />
        )}
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

export default DirectoryAdminSetting;
