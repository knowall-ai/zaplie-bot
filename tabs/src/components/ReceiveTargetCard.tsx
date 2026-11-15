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
  setMyReceiveTarget,
} from '../services/directory';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entry: MyDirectoryEntry };

const formatSats = (sats: number | null): string =>
  sats === null ? 'unavailable' : `${Math.floor(sats).toLocaleString()} sats`;

// Your Private wallet is your own LNbits wallet: Zaplie never holds a key that
// can spend from it. This card registers, once, where your zaps land — a
// Lightning address (preferred), or the invoice (read) key of the wallet,
// which also lets Zaplie show its balance. Neither is ever shown again.
const ReceiveTargetCard: FunctionComponent = () => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [address, setAddress] = useState('');
  const [invoiceKey, setInvoiceKey] = useState('');
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

  const save = async (target: {
    lightningAddress?: string | null;
    invoiceKey?: string | null;
  }) => {
    setSaving(true);
    setSaveError(null);
    try {
      await setMyReceiveTarget(target);
      setInvoiceKey('');
      toast.success('Saved where you receive zaps.');
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
  const registeredAddress = entry.receive.lightningAddress;
  const keyRegistered = entry.receive.invoiceKeyRegistered;

  return (
    <section className={styles.section} aria-labelledby="receive-heading">
      <div className={styles.sectionHeader}>
        <h2 id="receive-heading" className={styles.heading}>
          Where you receive zaps
        </h2>
        <p className={styles.intro}>
          Zaps you receive go to your own Private wallet. Zaplie never holds a
          key that can spend from it: give it your Lightning address, or the
          invoice (read-only) key of your Private wallet.
        </p>
      </div>
      <div className={styles.card}>
        <p className={styles.fieldLabel} data-testid="allowance-status">
          Allowance:{' '}
          {entry.allowanceWalletId
            ? formatSats(entry.allowanceSats)
            : 'not set up yet — ask a Zaplie admin'}
        </p>
        <p className={styles.fieldLabel} data-testid="receive-status">
          Receiving:{' '}
          {registeredAddress
            ? registeredAddress
            : keyRegistered
              ? 'Private wallet (invoice key)'
              : 'not set up — colleagues cannot zap you yet'}
        </p>
        {keyRegistered ? (
          <p className={styles.fieldLabel} data-testid="private-balance">
            Private wallet balance: {formatSats(entry.privateSats)}
          </p>
        ) : null}

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
            placeholder="name@your-lnbits-host"
            value={address}
            onChange={event => setAddress(event.target.value)}
            disabled={saving}
          />
          <button
            type="button"
            className={styles.primaryButton}
            disabled={
              saving || !address.trim() || address.trim() === registeredAddress
            }
            onClick={() => void save({ lightningAddress: address.trim() })}
          >
            Save
          </button>
          {registeredAddress ? (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={saving}
              onClick={() => void save({ lightningAddress: null })}
            >
              Remove
            </button>
          ) : null}
        </div>

        <label className={styles.fieldLabel} htmlFor="receive-invoice-key">
          Or the invoice key of your Private wallet (never the admin key)
        </label>
        <div className={styles.inputRow}>
          <input
            id="receive-invoice-key"
            className={`${styles.textBox} ${styles.editing}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              keyRegistered
                ? 'Registered — paste to replace'
                : '32 hexadecimal characters'
            }
            value={invoiceKey}
            onChange={event => setInvoiceKey(event.target.value)}
            disabled={saving}
          />
          <button
            type="button"
            className={styles.primaryButton}
            disabled={saving || !invoiceKey.trim()}
            onClick={() => void save({ invoiceKey: invoiceKey.trim() })}
          >
            Save key
          </button>
          {keyRegistered ? (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={saving}
              onClick={() => void save({ invoiceKey: null })}
            >
              Remove key
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
