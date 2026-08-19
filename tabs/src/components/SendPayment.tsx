import React, { useState, useContext } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import { IDetectedBarcode } from '@yudiel/react-qr-scanner';
import styles from './SendReceivePayment.module.css';
import qrCodeImage from '../images/QRCode.svg';
import checkmarkIcon from '../images/CheckmarkCircleGreen.svg';
import dismissIcon from '../images/DismissCircleRed.svg';
import pasteInvoice from '../images/PasteInvoice.svg';
import loaderGif from '../images/Loader.gif';
import { payInvoice } from '../services/lnbitsServiceLocal';
import { RewardNameContext } from './RewardNameContext';
import { parseInvoice } from '../utils/lightningInvoice';

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
  const [invoiceMemo, setInvoiceMemo] = useState<string | null>(null);
  const [scannerPaused, setScannerPaused] = useState(true);
  const [qrError, setQrError] = useState<string | null>(null);

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
    setIsLoading(false);
    setIsPaymentSuccess(false);
    setIsSuccessFailurePopupVisible(false);
    onClose();
  };

  const handleSendClick = async () => {
    setIsLoading(true);

    if (!myLNbitDetails.privateWallet) {
      handlePaymentFailure('Your Private wallet is unavailable.');
      return;
    }

    try {
      await payInvoice(myLNbitDetails.privateWallet.id, invoice);
      setIsPaymentSuccess(true);
      setIsSuccessFailurePopupVisible(true);
      setIsLoading(false);
    } catch {
      handlePaymentFailure(
        'The invoice could not be paid. It may be expired or your balance may be insufficient.',
      );
    }
  };

  const handleScanButtonClick = () => {
    setQrError(null);
    setIsScanning(true);
    setScannerPaused(false);
  };

  const handlePasteInvoiceClick = () => {
    setIsScanning(false);
    setScannerPaused(true);
  };

  const decodeAndSetInvoice = (processedInvoice: string) => {
    try {
      const parsed = parseInvoice(processedInvoice);
      setInvoiceAmount(parsed.amountSats);
      setInvoiceMemo(parsed.memo);
      setInvoice(processedInvoice);
      setFailureMessage('');
    } catch (error) {
      setInvoiceAmount(null);
      setInvoiceMemo(null);
      setFailureMessage(
        error instanceof Error
          ? error.message
          : 'Enter a valid Lightning invoice.',
      );
    }
  };

  const handleScan = (detectedCodes: IDetectedBarcode[]) => {
    if (detectedCodes.length > 0) {
      const data = detectedCodes[0].rawValue;
      const processedInvoice = data.split('lightning:').pop() || '';

      if (processedInvoice) {
        decodeAndSetInvoice(processedInvoice);
        setIsScanning(false);
        setScannerPaused(true);
      }
    }
  };

  const handleError = (error: unknown) => {
    const name =
      typeof error === 'object' && error && 'name' in error
        ? String(error.name)
        : '';
    setQrError(
      name === 'NotAllowedError'
        ? 'Camera access was denied. Enable camera access and try again.'
        : 'The camera could not be opened. Paste the invoice instead.',
    );
    setIsScanning(false);
    setScannerPaused(true);
  };

  const { rewardName } = useContext(RewardNameContext);

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.popup} role="dialog" aria-modal="true">
        <p className={styles.title}>Send payment</p>
        <p className={styles.text}>
          Show gratitude, thanks, and recognizing awesomeness to others in your
          team
        </p>

        {!isScanning && (
          <>
            <p className={styles.label}>Paste invoice</p>
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
                }
              }}
              className={styles.textarea}
              placeholder="Paste your invoice here"
            />
            <div className={styles.buttonContainer}>
              <button
                type="button"
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
                    value={`${invoiceAmount} ${
                      invoiceMemo && rewardName
                        ? ` ${rewardName}. Note: ${invoiceMemo}`
                        : ''
                    }`}
                    readOnly
                    className={styles.inputField}
                  />
                )}
                {failureMessage && (
                  <p role="alert" className={styles.errorText}>
                    {failureMessage}
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {isScanning && (
          <React.Fragment>
            <p className={styles.label}>Scan QR code</p>
            <div className={styles.qrReaderForm}>
              <div className={styles.qrReaderContainer}>
                <Scanner
                  constraints={{ facingMode: 'user' }}
                  scanDelay={300}
                  onError={handleError}
                  components={{ finder: false }}
                  paused={scannerPaused}
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
          <button
            type="button"
            onClick={handleCancelClick}
            className={styles.cancelButton}
          >
            Cancel
          </button>
          <div className={styles.sendOptions}>
            <button
              type="button"
              onClick={() => void handleSendClick()}
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
                type="button"
                className={styles.cancelButton}
                onClick={handleCancelClick}
              >
                Cancel
              </button>
              <button
                type="button"
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
