import React, { useState, useRef, useEffect } from 'react';
import QRCode from 'react-qr-code';
import styles from './SendReceivePayment.module.css';
import copyDoc from '../images/DocumentCopy.svg';
import copySuccess from '../images/CheckmarkCircleGreen.svg';
import { createInvoice, getWalletPayments } from '../services/lnbits/payments';
import { getWalletBalance } from '../services/lnbits/wallets';

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
  const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);
  const isSendDisabled = !inputValue || !inputNotes || isCreatingInvoice;
  const myLNbitDetails = currentUserLNbitDetails;
  const [invoice, setInvoice] = useState('');
  const [invoiceError, setInvoiceError] = useState('');
  const [walletBalance, setWalletBalance] = useState(0);
  const intervalId = useRef<NodeJS.Timeout | null>(null);
  // The button state only settles on the next render, so the ref is what stops
  // two rapid clicks from each creating an invoice and a poller.
  const invoicePending = useRef(false);

  useEffect(() => {
    console.log('walletBalance changed:', walletBalance);
    return () => {
      if (intervalId.current !== null) {
        window.clearInterval(intervalId.current);
      }
    };
  }, [walletBalance]);

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
    if (intervalId.current !== null) {
      window.clearInterval(intervalId.current);
      intervalId.current = null;
    }
    invoicePending.current = true;
    setIsCreatingInvoice(true);

    createInvoice(walletId, amount, inputNotes)
      .then(invoice => {
        console.log(invoice);
        setInvoice(invoice);

        // Start polling for payment
        intervalId.current = setInterval(() => {
          getWalletPayments(walletId)
            .then(payments => {
              if (payments.length > 0) {
                console.log('Payment received');
                if (intervalId.current !== null) {
                  window.clearInterval(intervalId.current);
                }

                console.log('Update the wallet balance in the context balance');
                // Update the wallet balance in the context balance
                getWalletBalance(walletId).then(balance => {
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
            })
            .catch(error => {
              console.error('Polling wallet payments failed, stopping:', error);
              if (intervalId.current !== null) {
                window.clearInterval(intervalId.current);
              }
            });
        }, 5000); // Check every 5 seconds
      })
      .catch(error => {
        console.error('Creating the invoice failed:', error);
        setInvoiceError('Creating the invoice failed. Close and try again.');
      })
      .finally(() => {
        invoicePending.current = false;
        setIsCreatingInvoice(false);
      });
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
