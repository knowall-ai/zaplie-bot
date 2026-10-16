import React, { useState, useRef, useEffect } from 'react';
import QRCode from 'react-qr-code';
import styles from './SendReceivePayment.module.css';
import copyDoc from '../images/DocumentCopy.svg';
import copySuccess from '../images/CheckmarkCircleGreen.svg';
import { createInvoice, getWalletPayments } from '../services/lnbits/payments';
import { getWalletBalance } from '../services/lnbits/wallets';
import { logger } from '../utils/logger';

interface ReceivePopupProps {
  onClose: () => void;
  currentUserLNbitDetails: User;
}

const ReceivePayment: React.FC<ReceivePopupProps> = ({
  onClose,
  currentUserLNbitDetails,
}) => {
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };
  const [inputValue, setInputValue] = useState('');
  const [inputNotes, setInputNotes] = useState('');
  const [buttonText, setButtonText] = useState('Copy');
  const [isSuccessFailurePopupVisible, setIsSuccessFailurePopupVisible] =
    useState(false);
  const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);
  const isSendDisabled = !inputValue || !inputNotes || isCreatingInvoice;
  const myLNbitDetails = currentUserLNbitDetails;
  const [invoice, setInvoice] = useState('');
  const [invoiceError, setInvoiceError] = useState('');
  const [, setWalletBalance] = useState(0);
  const timeoutId = useRef<number | null>(null);
  const isMounted = useRef(false);
  // The button state only settles on the next render, so the ref is what stops
  // two rapid clicks from each creating an invoice and a poller.
  const invoicePending = useRef(false);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      // In-flight requests cannot be cancelled here, so make their continuations
      // no-ops before clearing any check that has not started yet.
      isMounted.current = false;
      if (timeoutId.current !== null) {
        window.clearTimeout(timeoutId.current);
        timeoutId.current = null;
      }
    };
  }, []);

  const handleCancelClick = () => {
    onClose();
  };

  const handleNextClick = () => {
    if (invoicePending.current) {
      return;
    }
    setIsSuccessFailurePopupVisible(true);
    // A retry must not leave the previous invoice payable behind an error.
    setInvoice('');
    setButtonText('Copy');
    const walletId = myLNbitDetails.privateWallet?.id;
    const amountText = inputValue.trim();
    // A number input still accepts 1.5 and 1e3, and parseInt would quietly
    // invoice a different amount than the one on screen.
    const amount = /^\d+$/.test(amountText) ? Number(amountText) : NaN;
    if (!walletId) {
      setInvoiceError('Your private wallet is not available yet.');
      return;
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setInvoiceError('Enter a whole amount greater than zero.');
      return;
    }
    setInvoiceError('');

    // A second Next click must not strand the poller the first one started.
    if (timeoutId.current !== null) {
      window.clearTimeout(timeoutId.current);
      timeoutId.current = null;
    }
    invoicePending.current = true;
    setIsCreatingInvoice(true);

    createInvoice(walletId, amount, inputNotes)
      .then(invoice => {
        if (!isMounted.current) {
          return;
        }
        setInvoice(invoice);
        logger.debug('Invoice created; payment status polling started.');

        // Schedule the next one-shot check only after the current request
        // finishes, so a slow gateway response cannot create overlapping polls.
        const schedulePaymentCheck = () => {
          if (!isMounted.current) {
            return;
          }
          timeoutId.current = window.setTimeout(() => {
            timeoutId.current = null;
            void checkPayment();
          }, 5000);
        };

        const checkPayment = async () => {
          if (!isMounted.current) {
            return;
          }

          let payments: Transaction[];
          try {
            payments = await getWalletPayments(walletId);
          } catch {
            if (!isMounted.current) {
              return;
            }
            logger.error('Payment status polling failed, polling stopped.');
            setInvoiceError(
              'Unable to check payment status. Close and try again.',
            );
            return;
          }

          if (!isMounted.current) {
            return;
          }
          if (payments.length === 0) {
            schedulePaymentCheck();
            return;
          }

          logger.debug('Payment received.');
          try {
            const balance = await getWalletBalance(walletId);
            if (isMounted.current) {
              setWalletBalance(balance ?? 0);
              logger.debug('Wallet balance refresh completed.');
            }
          } catch {
            logger.error('Wallet balance refresh failed after payment.');
            if (isMounted.current) {
              setInvoiceError(
                'Payment received, but the balance could not be refreshed.',
              );
            }
          }
        };

        schedulePaymentCheck();
      })
      .catch(() => {
        logger.error('Invoice creation failed.');
        if (isMounted.current) {
          setInvoiceError('Creating the invoice failed. Close and try again.');
        }
      })
      .finally(() => {
        invoicePending.current = false;
        if (isMounted.current) {
          setIsCreatingInvoice(false);
        }
      });
  };

  const handleCopyClick = () => {
    // Logic to copy the text to clipboard
    const textToCopy = invoice;
    navigator.clipboard.writeText(textToCopy);
    setButtonText('Copied');
  };

  const handleCloseClick = () => {
    onClose();
  };

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.popupReceive}>
        <p className={styles.title}>Receive payment</p>
        <p className={styles.text}>
          Create an invoice to allow others to send you some payment
        </p>
        <div className={styles.container}>
          <div className={styles.inputRow}>
            <input
              type="number"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              className={styles.inputField}
              placeholder="Specify amount"
            />
          </div>
        </div>
        <p className={styles.text}>Note</p>
        <textarea
          value={inputNotes}
          onChange={e => setInputNotes(e.target.value)}
          className={styles.textarea}
          placeholder=""
        />
        <p></p>

        <div className={styles.actionRow}>
          <button onClick={handleCancelClick} className={styles.cancelButton}>
            Cancel
          </button>
          <div className={styles.sendOptions}>
            <button
              onClick={handleNextClick}
              className={
                isSendDisabled ? styles.sendButton : styles.sendButtonEnabled
              }
              disabled={isSendDisabled}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {isSuccessFailurePopupVisible && (
        <div className={styles.overlay} onClick={handleOverlayClick}>
          <div className={styles.receivePopupWithQrCode}>
            <p className={styles.title}>Receive payment</p>
            <p className={styles.text}>
              Create an invoice to allow others to send you some payment
            </p>
            <div className={styles.sendQrCodeContainer}>
              <div className={styles.qrCode}>
                {invoice && !invoiceError && (
                  <QRCode value={invoice} size={200} />
                )}
              </div>
              <div className={styles.txtContainer}>
                <div className={styles.title}>Lightning invoice</div>
                <div className={styles.txtContainer}>
                  {invoiceError ||
                    (!invoice
                      ? 'Loading...'
                      : invoice.length > 140
                        ? `${invoice.substring(0, 140)}...`
                        : invoice)}
                </div>
                {(invoice || invoiceError) && (
                  <div className={styles.receiveButtonContainer}>
                    {invoice && !invoiceError && (
                      <button
                        className={styles.copyButton}
                        onClick={handleCopyClick}
                      >
                        <img
                          src={buttonText === 'Copy' ? copyDoc : copySuccess}
                          alt={
                            buttonText === 'Copy' ? 'Copy Code' : 'Copy Success'
                          }
                          className={styles.copyIcon}
                        />
                        {buttonText}
                      </button>
                    )}
                    <button
                      className={styles.closeButton}
                      onClick={handleCloseClick}
                    >
                      Close
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReceivePayment;
