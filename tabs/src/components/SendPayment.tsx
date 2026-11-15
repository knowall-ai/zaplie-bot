import React, { useState, useEffect, useRef, useContext } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import { IDetectedBarcode } from '@yudiel/react-qr-scanner';
import styles from './SendReceivePayment.module.css';
import qrCodeImage from '../images/QRCode.svg';
import checkmarkIcon from '../images/CheckmarkCircleGreen.svg';
import dismissIcon from '../images/DismissCircleRed.svg';
import pasteInvoice from '../images/PasteInvoice.svg';
import loaderGif from '../images/Loader.gif';
import { payInvoice } from '../services/wallet/payments';
import { RewardNameContext } from './RewardNameContext';
import {
  INVOICE_ERRORS,
  isInvoiceErrorMessage,
  parseInvoice,
} from '../utils/lightningInvoice';

interface SendPopupProps {
  onClose: () => void;
  currentUserLNbitDetails: User;
}

const SendPayment: React.FC<SendPopupProps> = ({
  onClose,
  currentUserLNbitDetails,
}) => {
  const [invoice, setInvoice] = useState('');
  const [isPaymentSuccess, setIsPaymentSuccess] = useState(false);
  const [isSuccessFailurePopupVisible, setIsSuccessFailurePopupVisible] =
    useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const myLNbitDetails = currentUserLNbitDetails;
  const [invoiceAmount, setInvoiceAmount] = useState<number | null>(null);
  const isSendDisabled = !invoice || !invoiceAmount;
  const [failureMessage, setFailureMessage] = useState('');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const isMounted = useRef<boolean>(true);
  const [invoiceMemo, setInvoiceMemo] = useState<string | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [scannerPaused, setScannerPaused] = useState(true); // Make sure scanner starts paused
  const [qrError, setQrError] = useState<string | null>(null);

  // Effect for controlling scanner state
  useEffect(() => {
    return () => {
      isMounted.current = false;
      setScannerPaused(true); // Pause the scanner when the component unmounts
    };
  }, []);

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handlePaymentFailure = (message: string) => {
    setFailureMessage(message);
    setIsPaymentSuccess(false);
    setIsSuccessFailurePopupVisible(true);
    setIsLoading(false);
  };

  const handleCancelClick = () => {
    setIsLoading(true);
    setIsPaymentSuccess(false);
    setIsSuccessFailurePopupVisible(false);
    onClose();
  };

  const handleSendClick = () => {
    setIsLoading(true);

    if (!myLNbitDetails || !myLNbitDetails.privateWallet) {
      handlePaymentFailure('Something wrong with your wallet');
    } else {
      payInvoice(myLNbitDetails.privateWallet.id, invoice)
        .then(() => {
          setIsPaymentSuccess(true);
          setIsSuccessFailurePopupVisible(true); // Show the success popup
          setIsLoading(false);
        })
        .catch(error => {
          handlePaymentFailure(
            `Error paying invoice. The link might be expired or you do not have enough ${rewardsName} on your wallet`,
          );
        });
    }
  };

  const handleScanButtonClick = () => {
    setIsScanning(true);
    setScannerPaused(false); // Activate scanner when scanning starts
  };

  const handlePasteInvoiceClick = () => {
    setIsScanning(false);
    setScannerPaused(true); // Ensure scanner is paused when pasting the invoice manually
  };

  const debounce = (func: (...args: any[]) => void, delay: number) => {
    let timeoutId: NodeJS.Timeout;
    return (...args: any[]) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => func(...args), delay);
    };
  };

  // An amountless invoice used to leave the amount box editable, but the typed
  // value was never sent: `payInvoice` posts only `{ paymentRequest }` to the
  // gateway, whose POST /wallets/:walletId/payments route rejects any other
  // body key (`PAYMENT_BODY_KEYS` in tabs/backend/lnbitsRoutes.js). The wallet
  // would be asked to pay an invoice with no amount at all, so reject it here
  // instead of letting Send look armed.
  const decodeAndSetInvoice = (processedInvoice: string) => {
    try {
      const parsed = parseInvoice(processedInvoice);
      setInvoice(processedInvoice);
      setInvoiceAmount(parsed.amountSats);
      setInvoiceMemo(parsed.memo);
      setInvoiceError(null);
    } catch (error) {
      setInvoice(processedInvoice);
      setInvoiceAmount(null);
      setInvoiceMemo(null);
      // light-bolt11-decoder throws its own low-level text (for example
      // 'Wrong string length: 5 (lnbc1). Expected (8..9007199254740991)').
      // Only the messages parseInvoice raises itself are written for a user,
      // so anything else is replaced rather than shown raw.
      setInvoiceError(
        error instanceof Error && isInvoiceErrorMessage(error.message)
          ? error.message
          : INVOICE_ERRORS.undecodable,
      );
    }
  };

  const handleScan = debounce(async (detectedCodes: IDetectedBarcode[]) => {
    if (!isMounted.current) return;

    if (detectedCodes.length > 0) {
      const data = detectedCodes[0].rawValue;
      const processedInvoice = data.split('lightning:').pop() || '';

      if (processedInvoice) {
        decodeAndSetInvoice(processedInvoice);
        setIsScanning(false);
        setScannerPaused(true);
      }
    }
  }, 500);

  const handleError = (error: any) => {
    // Suppress the error to prevent it from throwing an uncaught runtime error
    try {
      console.error('QR Scan Error:', error);
      if (error.name === 'NotAllowedError') {
        setQrError(
          'Camera access was denied. Please enable camera permissions in your browser settings.',
        );
      } else {
        setQrError(
          'An error occurred while accessing the camera. Please try again.',
        );
      }
    } catch (err) {
      // If any other unexpected error occurs, log it but do not throw it to the console
      console.warn('Suppressed error:', err);
      setQrError('An unexpected error occurred. Please try again.');
    }
  };

  window.addEventListener('unhandledrejection', function (event) {
    if (event.reason.message.includes('Permission denied')) {
      // Prevent the error from being logged as uncaught
      event.preventDefault();
    }
  });

  const rewardNameContext = useContext(RewardNameContext);
  if (!rewardNameContext) {
    return null; // or handle the case where the context is not available
  }
  const rewardsName = rewardNameContext.rewardNameLabel;

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div
        className={styles.popup}
        style={{ height: isScanning ? '604px' : '420px' }}
      >
        <p className={styles.title}>Send payment</p>
        <p className={styles.text}>
          Show gratitude, thanks, and recognizing awesomeness to others in your
          team
        </p>

        {!isScanning && (
          <>
            <p className={styles.text}>Paste invoice</p>
            <textarea
              value={invoice}
              onChange={e => {
                const inputValue = e.target.value;
                const processedValue = inputValue
                  ? inputValue.split('lightning:').pop()
                  : '';
                setInvoice(processedValue || '');

                if (processedValue) {
                  decodeAndSetInvoice(processedValue);
                } else {
                  // Clearing the box has to clear what was parsed from the old
                  // invoice too, or the read-only amount and note stay on
                  // screen describing an invoice that is no longer there.
                  setInvoiceAmount(null);
                  setInvoiceMemo(null);
                  setInvoiceError(null);
                }
              }}
              className={styles.textarea}
              placeholder="Paste your invoice here"
            />
            <div className={styles.buttonContainer}>
              <button
                onClick={handleScanButtonClick}
                className={styles.scanButton}
              >
                <img
                  src={qrCodeImage}
                  alt="QR Code"
                  className={styles.qrIcon}
                />
                Scan QR code
              </button>
            </div>
            <div className={styles.container}>
              <div className={styles.inputRow}>
                {invoiceAmount !== null && (
                  <input
                    type="text"
                    aria-label="Invoice amount"
                    // The unit belongs to the amount, not to the note, so it
                    // is rendered whether or not the invoice carries a memo -
                    // a bare number on a payment screen is ambiguous.
                    value={`${invoiceAmount} ${rewardsName}${
                      invoiceMemo ? `. Note: ${invoiceMemo}` : ''
                    }`}
                    readOnly
                    className={styles.inputField}
                  />
                )}
                {invoiceError && (
                  <p role="alert" className={styles.errorText}>
                    {invoiceError}
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {isScanning && (
          <React.Fragment>
            <p className={styles.text}>Scan QR code</p>
            <div className={styles.qrReaderForm}>
              <div className={styles.qrReaderContainer}>
                <Scanner
                  constraints={{ facingMode: 'user' }}
                  scanDelay={300}
                  onError={handleError}
                  components={{ finder: false }}
                  paused={scannerPaused} // Ensure scanner is only active when scanning
                  onScan={handleScan}
                  styles={{
                    video: {
                      objectFit: 'cover',
                      width: '100%',
                      height: '100%',
                    },
                  }}
                />
              </div>
            </div>
            <button
              type="button"
              className={styles.scanButton}
              onClick={handlePasteInvoiceClick}
            >
              <img
                src={pasteInvoice}
                alt="paste invoice"
                className={styles.qrIcon}
              />
              Paste invoice
            </button>
          </React.Fragment>
        )}

        <div className={styles.actionRow}>
          <button onClick={handleCancelClick} className={styles.cancelButton}>
            Cancel
          </button>
          <div className={styles.sendOptions}>
            <button
              onClick={handleSendClick}
              className={
                isSendDisabled ? styles.sendButton : styles.sendButtonEnabled
              }
              disabled={isSendDisabled}
            >
              Send
            </button>
          </div>
        </div>
      </div>
      {isLoading && (
        <div className={styles.loaderOverlay}>
          <img src={loaderGif} alt="Loading..." className={styles.loaderIcon} />
          <p>Processing payment...</p>
        </div>
      )}
      {!isLoading && isSuccessFailurePopupVisible && isPaymentSuccess && (
        <div className={styles.overlay} onClick={handleOverlayClick}>
          <div className={styles.sendPopupSuccess}>
            <div className={styles.sendPopupHeader}>
              <img
                src={checkmarkIcon}
                alt="Checkmark"
                className={styles.checkmarkIcon}
              />
              <div className={styles.sendPopupText}>
                Payment sent successfully!
              </div>
            </div>
          </div>
        </div>
      )}
      {!isLoading && isSuccessFailurePopupVisible && !isPaymentSuccess && (
        <div className={styles.overlay} onClick={handleOverlayClick}>
          <div className={styles.sendPopupFailed}>
            <div className={styles.sendPopupHeader}>
              <img
                src={dismissIcon}
                alt="Dismiss"
                className={styles.checkmarkIcon}
              />
              <div className={styles.sendPopupText}>Payment cannot be sent</div>
            </div>
            <div className={styles.sendPopupSubText}>{failureMessage}</div>
            <div className={styles.buttonContainerSmallPopup}>
              <button
                className={styles.cancelButton}
                onClick={handleCancelClick}
              >
                Cancel
              </button>
              <button
                className={styles.changeAmountButton}
                onClick={handlePasteInvoiceClick}
              >
                Change amount
              </button>
            </div>
          </div>
        </div>
      )}
      {qrError && (
        <div className={styles.overlay} onClick={handleOverlayClick}>
          <div className={styles.errorPopup}>
            <div className={styles.sendPopupHeader}>
              <img
                src={dismissIcon}
                alt="Error"
                className={styles.checkmarkIcon}
              />
              <div className={styles.sendPopupText}>{qrError}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SendPayment;
