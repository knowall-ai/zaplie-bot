import React, {
  FunctionComponent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { toast } from 'react-toastify';
import styles from './setting.module.css';
import {
  getMyDirectoryEntry,
  MyDirectoryEntry,
  setMyReceiveAddress,
} from '../services/directory';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entry: MyDirectoryEntry };

const formatSats = (sats: number | null): string =>
  sats === null ? 'unavailable' : `${Math.floor(sats).toLocaleString()} sats`;

// Your Private wallet is your own: Zaplie only ever pays into it, at the
// Lightning address you register here once. Any Lightning wallet works,
// within the domains your organisation allows.
const ReceiveTargetCard: FunctionComponent = () => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const entry = await getMyDirectoryEntry();
      setState({ status: 'ready', entry });
      setAddress(entry.receive.lightningAddress || '');
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof Error && /No Zaplie wallet/.test(error.message)
            ? 'You are not set up in Zaplie yet. Send the Zaplie bot a message in Teams, or ask an admin.'
            : "We couldn't load your wallet details. Try again.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (lightningAddress: string | null) => {
    setSaving(true);
    setSaveError(null);
    try {
      await setMyReceiveAddress(lightningAddress);
      toast.success(
        lightningAddress
          ? 'Saved where you receive zaps.'
          : 'Removed your Lightning address.',
      );
      await load();
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : 'Saving failed. Try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  if (state.status === 'loading') {
    return (
      <section className={styles.section} aria-busy="true">
        <span className={styles.inputSkeleton} />
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className={styles.section}>
        <div className={styles.card}>
          <p className={styles.errorText} role="alert">
            {state.message}
          </p>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      </section>
    );
  }

  const { entry } = state;
  const registered = entry.receive.lightningAddress;
  const budget = entry.budget;
  const remaining =
    budget && budget.totalSats !== null && budget.usedSats !== null
      ? Math.max(0, budget.totalSats - budget.usedSats)
      : null;
  const domains = entry.receiveDomains || [];
  const placeholder = `name@${domains[0] || 'your-wallet-host'}`;

  return (
    <section className={styles.section} aria-labelledby="receive-heading">
      <div className={styles.sectionHeader}>
        <h2 id="receive-heading" className={styles.heading}>
          Where you receive zaps
        </h2>
        <p className={styles.intro}>
          Zaps you receive go to your own Private wallet. Zaplie never holds a
          key to it and only ever pays into it.
        </p>
      </div>
      <div className={styles.card}>
        <dl className={styles.statusList}>
          <dt>Allowance</dt>
          <dd data-testid="allowance-status">
            {entry.allowanceWalletId ? (
              formatSats(entry.allowanceSats)
            ) : (
              <>
                <span className={styles.pill}>Not set up</span>
                <span className={styles.helperText}>Ask a Zaplie admin</span>
              </>
            )}
          </dd>
          {remaining !== null ? (
            <>
              <dt>Left to send this period</dt>
              <dd data-testid="allowance-budget">{formatSats(remaining)}</dd>
            </>
          ) : null}
          <dt>Receiving at</dt>
          <dd data-testid="receive-status">
            {registered ? (
              <>
                <span className={styles.pillOk}>Ready</span>
                {registered}
              </>
            ) : (
              <span className={styles.pillWarning}>Not set up</span>
            )}
          </dd>
        </dl>

        {registered ? null : (
          <p className={styles.calloutWarning} role="note">
            <span className={styles.calloutTitle}>
              Colleagues can&apos;t zap you yet
            </span>
            Add your Lightning address below so zaps reach your wallet.
          </p>
        )}

        <hr className={styles.divider} />

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="receive-address">
            Lightning address
          </label>
          <div className={styles.inputRow}>
            <input
              id="receive-address"
              className={`${styles.textBox} ${styles.editing}`}
              type="text"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              placeholder={placeholder}
              aria-describedby="receive-address-help"
              value={address}
              onChange={event => setAddress(event.target.value)}
              disabled={saving}
            />
            <button
              type="button"
              className={styles.primaryButton}
              disabled={
                saving || !address.trim() || address.trim() === registered
              }
              onClick={() => void save(address.trim())}
            >
              Save
            </button>
            {registered ? (
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={saving}
                onClick={() => void save(null)}
              >
                Remove
              </button>
            ) : null}
          </div>
          <p id="receive-address-help" className={styles.helperText}>
            A Lightning address looks like an email address and tells Zaplie
            where to send your zaps. Find it on your wallet&apos;s Receive
            screen.
            {domains.length > 0
              ? ` Accepted here: ${domains.map(d => `name@${d}`).join(', ')}.`
              : ''}
          </p>
        </div>

        {saveError ? (
          <p className={styles.errorText} role="alert">
            {saveError}
          </p>
        ) : null}
      </div>
    </section>
  );
};

export default ReceiveTargetCard;
