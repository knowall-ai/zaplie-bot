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
  getTenantMe,
  groupMembersLink,
  enterpriseAppUsersLink,
  TenantMe,
} from '../services/tenant';
import {
  addGroupMember,
  canManageMembers,
  GraphPermissionMissingError,
  GroupMember,
  listGroupMembers,
  removeGroupMember,
} from '../services/graphAdmins';

type State =
  | { status: 'loading' }
  | { status: 'no-group'; tenant: TenantMe }
  | { status: 'no-permission'; tenant: TenantMe }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      tenant: TenantMe;
      members: GroupMember[];
      writable: boolean;
    };

// Settings -> Admins (Zaplie admins only). The members of the organisation's
// "Zaplie Admins" group, straight from Microsoft Graph with the signed-in
// admin's own token: Entra is the single source of truth. Adding and removing
// appear only when the tenant granted the optional GroupMember.ReadWrite.All
// and Graph lets this admin manage the group; otherwise the list is read-only
// with a link to Entra.
const AdminsSetting: FunctionComponent = () => {
  const { accounts } = useMsal();
  const isAdmin = isZaplieAdmin(accounts[0]);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [newAdmin, setNewAdmin] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const tenant = await getTenantMe();
      const groupId = tenant.settings.adminsGroupId;
      if (!groupId) {
        setState({ status: 'no-group', tenant });
        return;
      }
      try {
        const [members, writable] = await Promise.all([
          listGroupMembers(groupId),
          canManageMembers(),
        ]);
        setState({ status: 'ready', tenant, members, writable });
      } catch (error) {
        if (error instanceof GraphPermissionMissingError) {
          setState({ status: 'no-permission', tenant });
          return;
        }
        throw error;
      }
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Admins are unavailable.',
      });
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) return null;

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      setNewAdmin('');
      await load();
    } catch (error) {
      setActionError(
        error instanceof GraphPermissionMissingError
          ? 'Microsoft Graph refused: you cannot manage this group here. Change it in Entra instead.'
          : error instanceof Error
            ? error.message
            : 'That did not work.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="admins-heading">
      <div className={styles.sectionHeader}>
        <h2 id="admins-heading" className={styles.heading}>
          Admins
        </h2>
        <p className={styles.intro}>
          Zaplie admins are the members of your organisation&apos;s Zaplie
          Admins group in Entra, which holds the Zaplie.Admin role. Your Global
          Administrators are always admins too.
        </p>
      </div>
      <div className={styles.card}>
        {state.status === 'loading' ? (
          <span className={styles.inputSkeleton} />
        ) : null}
        {state.status === 'error' ? (
          <p className={styles.errorText} role="alert">
            {state.message}
          </p>
        ) : null}
        {state.status === 'no-group' ? (
          <p className={styles.calloutInfo} data-testid="admins-no-group">
            <span className={styles.calloutTitle}>
              No Zaplie Admins group yet
            </span>
            <a className={styles.link} href="/setup">
              Set up your organisation
            </a>{' '}
            to choose the Entra group whose members are Zaplie admins.
          </p>
        ) : null}
        {state.status === 'no-permission' ? (
          <p
            className={styles.calloutWarning}
            data-testid="admins-no-permission"
          >
            <span className={styles.calloutTitle}>
              Zaplie can&apos;t read the admins group
            </span>
            An administrator has not granted Zaplie the GroupMember.Read.All
            permission. See the members in{' '}
            <a
              className={styles.link}
              href={groupMembersLink(state.tenant.settings.adminsGroupId || '')}
              target="_blank"
              rel="noopener noreferrer"
            >
              Entra
            </a>
            .
          </p>
        ) : null}
        {state.status === 'ready' ? (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table} aria-label="Zaplie admins">
                <thead>
                  <tr>
                    <th scope="col">Admin</th>
                    {state.writable ? (
                      <th scope="col">
                        <span className={styles.visuallyHidden}>Actions</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {state.members.length === 0 ? (
                    <tr>
                      <td className={styles.helperText}>
                        The group has no members yet.
                      </td>
                    </tr>
                  ) : null}
                  {state.members.map(member => (
                    <tr key={member.id}>
                      <td className={styles.primaryCell}>
                        {member.displayName}
                        {member.userPrincipalName ? (
                          <span className={styles.secondaryLine}>
                            {member.userPrincipalName}
                          </span>
                        ) : null}
                      </td>
                      {state.writable ? (
                        <td className={styles.actionCell}>
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            disabled={busy}
                            aria-label={`Remove ${member.displayName}`}
                            onClick={() =>
                              void act(() =>
                                removeGroupMember(
                                  state.tenant.settings.adminsGroupId || '',
                                  member.id,
                                ),
                              )
                            }
                          >
                            Remove
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {state.writable ? (
              <div className={styles.inputRow}>
                <input
                  aria-label="New admin's sign-in name"
                  className={`${styles.textBox} ${styles.editing}`}
                  placeholder="person@your-organisation"
                  value={newAdmin}
                  onChange={event => setNewAdmin(event.target.value)}
                  disabled={busy}
                />
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={busy || !newAdmin.includes('@')}
                  onClick={() =>
                    void act(() =>
                      addGroupMember(
                        state.tenant.settings.adminsGroupId || '',
                        newAdmin.trim(),
                      ),
                    )
                  }
                >
                  Add admin
                </button>
              </div>
            ) : (
              <p className={styles.helperText} data-testid="admins-read-only">
                Read-only here. Add or remove admins in{' '}
                <a
                  className={styles.link}
                  href={groupMembersLink(
                    state.tenant.settings.adminsGroupId || '',
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Entra
                </a>
                , or grant Zaplie the optional GroupMember.ReadWrite.All
                permission.
              </p>
            )}
            <p className={styles.helperText}>
              <a
                className={styles.link}
                href={enterpriseAppUsersLink(state.tenant.clientId)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Enterprise application: users and groups
              </a>
            </p>
          </>
        ) : null}
        {actionError ? (
          <p className={styles.errorText} role="alert">
            {actionError}
          </p>
        ) : null}
      </div>
    </section>
  );
};

export default AdminsSetting;
