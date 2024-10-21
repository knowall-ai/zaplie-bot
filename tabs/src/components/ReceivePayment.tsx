import React, { useState, useRef, useContext, useEffect } from 'react';
import QRCode from 'react-qr-code';
import styles from './SendReceivePayment.module.css';
import copyDoc from '../images/DocumentCopy.svg';
import copySuccess from '../images/CheckmarkCircleGreen.svg';
import {
  createInvoice,
  getWalletPayments,
  getWalletBalance,
} from '../services/lnbitsServiceLocal';

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
  const [textToCopy, setTextToCopy] = useState('');
  const [buttonText, setButtonText] = useState('Copy');
  const [isSuccessFailurePopupVisible, setIsSuccessFailurePopupVisible] =
    useState(false);
  const isSendDisabled = !inputValue || !inputNotes;
  const myLNbitDetails = currentUserLNbitDetails;
  const [invoice, setInvoice] = useState('');
  const [paymentReceived, setPaymentReceived] = useState(false);
  const [walletBalance, setWalletBalance] = useState(0);
  const intervalId = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setPaymentReceived(false);
  }, [currentUserLNbitDetails]);

  useEffect(() => {
    console.log('walletBalance changed:', walletBalance);
  }, [walletBalance]);

  const handleCancelClick = () => {
    onClose();
  };

  const handleNextClick = () => {
    setIsSuccessFailurePopupVisible(true);
    if (myLNbitDetails) {
      if (myLNbitDetails) {
        createInvoice(
          myLNbitDetails.privateWallet?.inkey || '',
          myLNbitDetails.privateWallet?.id || '',
          parseInt(inputValue) || 0,
          inputNotes,
        ).then(invoice => {
          console.log(invoice);
          setInvoice(invoice);

          // Record the current timestamp
          const timestamp = Math.floor(Date.now() / 1000);

          // Start polling for payment
          intervalId.current = setInterval(() => {
            getWalletPayments(myLNbitDetails.privateWallet?.inkey || '').then(
              payments => {
                if (payments.length > 0) {
                  console.log('Payment received');
                  setPaymentReceived(true);
                  if (intervalId.current !== null) {
                    window.clearInterval(intervalId.current);
                  }

                  console.log(
                    'Update the wallet balance in the context balance',
                  );
                  // Update the wallet balance in the context balance
                  getWalletBalance(
                    myLNbitDetails.privateWallet?.inkey || '',
                  ).then(balance => {
                    console.log('getWalletBalance:', balance);
                    // Use the new function to set the balance
                    if (balance !== null) {
                      console.log('setWalletBalance to ', balance);
                      setWalletBalance(balance);
                    } else {
                      // Handle the case when balance is null
                      // For example, set a default value or show an error message
                      setWalletBalance(0);
                    }
                  });
                }
              },
            );
          }, 5000); // Check every 5 seconds
        });
      } else {
        console.error('Wallet inkey is not defined yet.');
      }
    }
  };

  const handleCopyClick = () => {
    // Logic to copy the text to clipboard
    const textToCopy = invoice;
    navigator.clipboard.writeText(textToCopy);
    console.log('Text copied to clipboard: ', textToCopy);
    setButtonText('Copied');
    console.log('Text copied to clipboard: ', setButtonText);
  };

  const handleCloseClick = () => {
    setTextToCopy('');
    onClose();
    console.log('Text copied to clipboard: ', textToCopy);
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
                {invoice && <QRCode value={invoice} size={200} />}
              </div>
              <div className={styles.txtContainer}>
                <div className={styles.title}>Lightning invoice</div>
                <div className={styles.txtContainer}>
                  {!invoice
                    ? 'Loading...'
                    : invoice.length > 140
                    ? `${invoice.substring(0, 140)}...`
                    : invoice}
                </div>
                {invoice && (
                  <div className={styles.receiveButtonContainer}>
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
