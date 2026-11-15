import React, {
  FunctionComponent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { toast } from 'react-toastify';
import styles from './setting.module.css';
import { classifyError } from '../utils/appErrors';
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
      const kind = classifyError(error);
      setState({
        status: 'error',
        message:
          error instanceof Error && /No Zaplie wallet/.test(error.message)
            ? 'You are not set up in Zaplie yet. Send the Zaplie bot a message in Teams, or ask an admin.'
            : kind === 'signed-out'
              ? 'Your session has ended. Sign in again to see your wallet.'
              : kind === 'wallet-unreachable'
                ? 'The wallet service is unreachable right now. Nothing was paid; try again in a minute.'
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

  return (
    <section className={styles.section} aria-labelledby="receive-heading">
      <div className={styles.sectionHeader}>
        <h2 id="receive-heading" className={styles.heading}>
          Where you receive zaps
        </h2>
        <p className={styles.intro}>
          Zaps you receive go to your own Private wallet. Zaplie never holds a
          key to it and only ever pays into it: give it your wallet&apos;s
          Lightning address.
        </p>
      </div>
      <div className={styles.card}>
        <p className={styles.fieldLabel} data-testid="allowance-status">
          Allowance:{' '}
          {entry.allowanceWalletId
            ? formatSats(entry.allowanceSats)
            : 'not set up yet — ask a Zaplie admin'}
        </p>
        {remaining !== null ? (
          <p className={styles.fieldLabel} data-testid="allowance-budget">
            Left to send this period: {formatSats(remaining)}
          </p>
        ) : null}
        <p className={styles.fieldLabel} data-testid="receive-status">
          Receiving at:{' '}
          {registered || 'not set up — colleagues cannot zap you yet'}
        </p>

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
            placeholder="name@your-wallet-host"
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
