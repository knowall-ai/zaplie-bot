import React, { useState, useContext } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import { IDetectedBarcode } from '@yudiel/react-qr-scanner';
import styles from './SendReceivePayment.module.css';
import qrCodeImage from '../images/QRCode.svg';
import checkmarkIcon from '../images/CheckmarkCircleGreen.svg';
import dismissIcon from '../images/DismissCircleRed.svg';
import pasteInvoice from '../images/PasteInvoice.svg';
import loaderGif from '../images/Loader.gif';
import { decode } from 'light-bolt11-decoder';
import { payInvoice } from '../services/lnbitsServiceLocal';
import { RewardNameContext } from './RewardNameContext';

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

  const handleSendClick = () => {
    setIsLoading(true);

    if (!myLNbitDetails || !myLNbitDetails.privateWallet) {
      handlePaymentFailure('Something wrong with your wallet');
    } else {
      payInvoice(myLNbitDetails.privateWallet.id, invoice)
        .then(() => {
          setIsPaymentSuccess(true);
          setIsSuccessFailurePopupVisible(true);
          setIsLoading(false);
        })
        .catch(() => {
          handlePaymentFailure(
            `Error paying invoice. The link might be expired or you do not have enough ${rewardsName} on your wallet`,
          );
        });
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

  const decodeAndSetInvoice = async (processedInvoice: string) => {
    try {
      const decodedInvoice = decode(processedInvoice);
      const amountSection = decodedInvoice.sections.find(
        (section: any) => section.name === 'amount',
      ) as { name: string; value: string } | null;

      const amountValue = amountSection ? parseInt(amountSection.value) : null;
      const invoiceAmountInSatoshis = amountValue ? amountValue / 1000 : null;

      const memoSection = decodedInvoice.sections.find(
        (section: any) => section.name === 'description',
      ) as { name: string; value: string } | null;
      const memoValue = memoSection ? String(memoSection.value) : undefined;

      setInvoiceAmount(
        invoiceAmountInSatoshis !== null
          ? parseInt(invoiceAmountInSatoshis.toString())
          : null,
      );
      setInvoiceMemo(memoValue ?? null);
      setInvoice(processedInvoice);
      if (!invoiceAmountInSatoshis) {
        setFailureMessage('The invoice must include an amount.');
      } else {
        setFailureMessage('');
      }
    } catch {
      setInvoiceAmount(null);
      setInvoiceMemo(null);
      setFailureMessage('Enter a valid Lightning invoice.');
    }
  };

  const handleScan = async (detectedCodes: IDetectedBarcode[]) => {
    if (detectedCodes.length > 0) {
      const data = detectedCodes[0].rawValue;
      const processedInvoice = data.split('lightning:').pop() || '';

      if (processedInvoice) {
        await decodeAndSetInvoice(processedInvoice);
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

  const rewardNameContext = useContext(RewardNameContext);
  const rewardsName = rewardNameContext.rewardName;

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
              onChange={async e => {
                const inputValue = e.target.value;
                const processedValue = inputValue
                  ? inputValue.split('lightning:').pop()
                  : '';
                setInvoice(processedValue || '');

                if (processedValue) {
                  await decodeAndSetInvoice(processedValue);
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
                      invoiceMemo ? ` ${rewardsName}. Note: ${invoiceMemo}` : ''
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
