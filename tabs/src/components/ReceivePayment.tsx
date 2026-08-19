import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'react-qr-code';
import styles from './SendReceivePayment.module.css';
import copyDoc from '../images/DocumentCopy.svg';
import copySuccess from '../images/CheckmarkCircleGreen.svg';
import {
  createInvoice,
  getInvoicePayment,
} from '../services/lnbitsServiceLocal';

interface ReceivePopupProps {
  onClose: () => void;
  currentUserLNbitDetails: User;
}

type InvoiceStatus = 'form' | 'creating' | 'waiting' | 'paid' | 'error';

const ReceivePayment: React.FC<ReceivePopupProps> = ({
  onClose,
  currentUserLNbitDetails,
}) => {
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [paymentRequest, setPaymentRequest] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [status, setStatus] = useState<InvoiceStatus>('form');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollTimer = useRef<number | null>(null);
  const pollCount = useRef(0);
  const privateWallet = currentUserLNbitDetails.privateWallet;

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    if (status !== 'waiting' || !privateWallet || !invoiceId) return;

    const poll = async () => {
      try {
        const payment = await getInvoicePayment(privateWallet.id, invoiceId);
        if (payment.paid || payment.status === 'paid') {
          setStatus('paid');
          return;
        }

        pollCount.current += 1;
        if (pollCount.current >= 120) {
          setError(
            'Payment was not detected before the invoice check timed out.',
          );
          setStatus('error');
          return;
        }
        pollTimer.current = window.setTimeout(poll, 5000);
      } catch (pollError) {
        setError(
          pollError instanceof Error
            ? pollError.message
            : 'The invoice status could not be checked.',
        );
        setStatus('error');
      }
    };

    pollTimer.current = window.setTimeout(poll, 5000);
    return stopPolling;
  }, [invoiceId, privateWallet, status, stopPolling]);

  const create = async () => {
    const parsedAmount = Number(amount);
    if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) {
      setError('Enter a positive whole-Sat amount.');
      return;
    }
    if (!memo.trim()) {
      setError('Add a note for this invoice.');
      return;
    }
    if (!privateWallet) {
      setError('Your Private wallet is unavailable.');
      return;
    }

    setStatus('creating');
    setError(null);
    try {
      const result = await createInvoice(
        privateWallet.id,
        parsedAmount,
        memo.trim(),
      );
      setPaymentRequest(result.paymentRequest);
      setInvoiceId(result.invoiceId);
      pollCount.current = 0;
      setStatus('waiting');
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'The invoice could not be created.',
      );
      setStatus('error');
    }
  };

  const copyInvoice = async () => {
    try {
      await navigator.clipboard.writeText(paymentRequest);
      setCopied(true);
    } catch {
      setError('The invoice could not be copied. Select and copy it manually.');
    }
  };

  const close = () => {
    stopPolling();
    onClose();
  };

  const showInvoice = Boolean(paymentRequest);

  return (
    <div
      className={styles.overlay}
      onClick={event => event.target === event.currentTarget && close()}
    >
      <div
        className={
          showInvoice ? styles.receivePopupWithQrCode : styles.popupReceive
        }
        role="dialog"
        aria-modal="true"
      >
        <h2 className={styles.title}>Receive payment</h2>
        {!showInvoice ? (
          <>
            <p className={styles.text}>
              Create a Lightning invoice for your Private wallet.
            </p>
            <label className={styles.label} htmlFor="receive-amount">
              Amount
            </label>
            <input
              id="receive-amount"
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={event => setAmount(event.target.value)}
              className={styles.inputField}
              placeholder="Amount in Sats"
            />
            <label className={styles.label} htmlFor="receive-memo">
              Note
            </label>
            <textarea
              id="receive-memo"
              value={memo}
              onChange={event => setMemo(event.target.value)}
              className={styles.textarea}
            />
            {error && (
              <p className={styles.errorText} role="alert">
                {error}
              </p>
            )}
            <div className={styles.actionRow}>
              <button
                type="button"
                onClick={close}
                className={styles.cancelButton}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void create()}
                className={styles.sendButtonEnabled}
                disabled={status === 'creating'}
              >
                {status === 'creating' ? 'Creating…' : 'Create invoice'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.text} aria-live="polite">
              {status === 'paid'
                ? 'Payment received.'
                : status === 'error'
                  ? 'Invoice status could not be confirmed.'
                  : 'Waiting for payment…'}
            </p>
            <div className={styles.sendQrCodeContainer}>
              <div className={styles.qrCode}>
                <QRCode value={paymentRequest} size={200} />
              </div>
              <div className={styles.txtContainer}>
                <div className={styles.label}>Lightning invoice</div>
                <div className={styles.invoiceText}>{paymentRequest}</div>
                {error && (
                  <p className={styles.errorText} role="alert">
                    {error}
                  </p>
                )}
                <div className={styles.receiveButtonContainer}>
                  <button
                    type="button"
                    className={styles.copyButton}
                    onClick={() => void copyInvoice()}
                  >
                    <img
                      src={copied ? copySuccess : copyDoc}
                      alt=""
                      className={styles.copyIcon}
                    />
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    className={styles.closeButton}
                    onClick={close}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default ReceivePayment;
