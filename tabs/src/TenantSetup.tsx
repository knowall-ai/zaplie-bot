import React, {
  FunctionComponent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { useMsal } from '@azure/msal-react';
import styles from './components/setting.module.css';
import settingsStyles from './components/Settings.module.css';
import { isSetupAdmin } from './services/adminRole';
import {
  enterpriseAppUsersLink,
  getTenantMe,
  saveTenantSetup,
  TenantMe,
} from './services/tenant';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Set up your organisation": for the IT admin who granted consent (Global,
// Privileged Role, Cloud Application or Application Administrator, from the
// token's wids) and for Zaplie admins. Everything here applies to the
// signed-in admin's own organisation only; the backend enforces it.
const TenantSetup: FunctionComponent = () => {
  const { accounts } = useMsal();
  const allowed = isSetupAdmin(accounts[0]);
  const [tenant, setTenant] = useState<TenantMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState('');
  const [guests, setGuests] = useState('');
  const [budget, setBudget] = useState('25000');
  const [period, setPeriod] = useState('weekly');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const me = await getTenantMe();
      setTenant(me);
      setGroupId(me.settings.adminsGroupId || '');
      setGuests(me.settings.guestAllowlist.join('\n'));
      setBudget(String(me.settings.provisioner.defaultBudgetSats));
      setPeriod(me.settings.provisioner.defaultPeriod);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Your organisation could not be loaded.',
      );
    }
  }, []);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (!allowed) {
    return (
      <div className={settingsStyles.page}>
        <p className={styles.errorText} role="alert">
          Only your organisation&apos;s administrators can set up Zaplie.
        </p>
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await saveTenantSetup({
        adminsGroupId: groupId.trim() || null,
        guestAllowlist: guests
          .split(/[\n,]/)
          .map(entry => entry.trim())
          .filter(Boolean),
        provisioner: {
          defaultBudgetSats: Number.parseInt(budget, 10),
          defaultPeriod: period,
        },
      });
      setTenant(previous =>
        previous ? { ...previous, settings: result.settings } : previous,
      );
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Saving failed.');
    } finally {
      setSaving(false);
    }
  };

  const usersLink = enterpriseAppUsersLink(tenant?.clientId || null);

  return (
    <div className={settingsStyles.page}>
      <header className={settingsStyles.pageHeader}>
        <h1 className={settingsStyles.pageTitle}>Set up your organisation</h1>
      </header>
      {tenant ? (
        <p className={styles.intro}>Organisation (tenant) {tenant.tid}</p>
      ) : null}

      <section className={styles.section} aria-labelledby="setup-admins">
        <h2 id="setup-admins" className={styles.heading}>
          1. Zaplie Admins group
        </h2>
        <ol className={styles.intro}>
          <li>
            In Entra, create a security group, for example &quot;Zaplie
            Admins&quot;, and add your admins.
          </li>
          <li>
            In{' '}
            <a href={usersLink} target="_blank" rel="noopener noreferrer">
              Enterprise applications → Zaplie → Users and groups
            </a>
            , assign that group the <strong>Zaplie.Admin</strong> role.
          </li>
          <li>
            Paste the group&apos;s object id here so Settings → Admins can show
            its members.
          </li>
        </ol>
        <input
          aria-label="Zaplie Admins group object id"
          className={`${styles.textBox} ${styles.editing}`}
          placeholder="00000000-0000-0000-0000-000000000000"
          value={groupId}
          onChange={event => setGroupId(event.target.value)}
        />
        <p className={styles.intro}>
          Your Global Administrators are always Zaplie admins, so nobody is
          locked out.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="setup-who">
        <h2 id="setup-who" className={styles.heading}>
          2. Who can use Zaplie
        </h2>
        <p className={styles.intro}>
          Everyone in your organisation can sign in unless you restrict it: in
          the same Enterprise application, open <em>Properties</em> and set{' '}
          <strong>Assignment required</strong> to Yes, then assign the people or
          groups who should use Zaplie under Users and groups.
        </p>
        <label className={styles.fieldLabel} htmlFor="setup-guests">
          Guests and other people allowed in (one per line: person@domain,
          @domain or an object id)
        </label>
        <textarea
          id="setup-guests"
          className={`${styles.textArea} ${styles.editing}`}
          value={guests}
          onChange={event => setGuests(event.target.value)}
        />
      </section>

      <section className={styles.section} aria-labelledby="setup-wallets">
        <h2 id="setup-wallets" className={styles.heading}>
          3. Wallets
        </h2>
        <p className={styles.intro}>
          Defaults for Settings → People and Allowance wallets → Add people: the
          allowance budget each new wallet&apos;s NWC connection gets, and how
          often it renews.
        </p>
        <div className={styles.inputRow}>
          <input
            aria-label="Default budget (sats per period)"
            type="number"
            min={1}
            className={`${styles.textBox} ${styles.editing}`}
            value={budget}
            onChange={event => setBudget(event.target.value)}
          />
          <select
            aria-label="Default period"
            value={period}
            onChange={event => setPeriod(event.target.value)}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
      </section>

      {error ? (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      ) : null}
      {saved ? <p role="status">Saved.</p> : null}
      <button
        type="button"
        className={styles.primaryButton}
        disabled={
          saving || (groupId.trim() !== '' && !GUID.test(groupId.trim()))
        }
        onClick={() => void save()}
      >
        Save
      </button>
    </div>
  );
};

export default TenantSetup;
