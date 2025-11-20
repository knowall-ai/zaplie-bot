import React, { useEffect, useState, useContext } from 'react';
import './WalletInfoCard.css';
import ArrowClockwise from '../images/ArrowClockwise.svg';
import { getUsers, getUserWallets } from '../services/lnbitsServiceLocal';
import { useMsal } from '@azure/msal-react';
import SendPayment from './SendPayment';
import ReceivePayment from './ReceivePayment';
import { RewardNameContext } from './RewardNameContext';

const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;


const WalletYourWalletInfoCard: React.FC = () => {

  const [balance, setBalance] = useState<number>();

  const [isReceivePopupOpen, setIsReceivePopupOpen] = useState(false);
  const [isSendPopupOpen, setIsSendPopupOpen] = useState(false);
  const { accounts } = useMsal();
  const account = accounts[0];
  const [myLNbitDetails, setMyLNbitDetails] = useState<User>();

  const fetchAmountReceived = async () => {
    console.log('=== WalletInfoCard: Fetching your wallet ===');
    console.log('WalletInfoCard: account.localAccountId =', account.localAccountId);

    const currentUserLNbitDetails = await getUsers(adminKey, {
      aadObjectId: account.localAccountId,
    });

    console.log('WalletInfoCard: Users returned from getUsers =', currentUserLNbitDetails);

    if (currentUserLNbitDetails && currentUserLNbitDetails.length > 0) {
      const user = currentUserLNbitDetails[0];
      console.log('WalletInfoCard: Current user =', user);
      console.log('WalletInfoCard: Current user.id =', user.id);

      // Fetch user's wallets
      const userWallets = await getUserWallets(adminKey, user.id);
      console.log('WalletInfoCard: User wallets returned =', userWallets);

      if (userWallets && userWallets.length > 0) {
        console.log('WalletInfoCard: Searching for Private wallet in', userWallets.length, 'wallets');
        userWallets.forEach(w => {
          console.log('WalletInfoCard: Wallet name:', w.name, '| balance_msat:', w.balance_msat);
        });

        // Find the Private wallet
        const privateWallet = userWallets.find(w =>
          w.name.toLowerCase().includes('private')
        );

        console.log('WalletInfoCard: Private wallet found?', !!privateWallet);
        if (privateWallet) {
          console.log('WalletInfoCard: Private wallet details:', privateWallet);
          console.log('WalletInfoCard: balance_msat =', privateWallet.balance_msat);

          // Update user object with the wallet
          user.privateWallet = privateWallet;
          setMyLNbitDetails(user);

          // Set balance
          const bal = (privateWallet.balance_msat ?? 0) / 1000;
          console.log('WalletInfoCard: Calculated balance (sats) =', bal);
          setBalance(bal);
        } else {
          console.log('WalletInfoCard: ERROR - Private wallet not found!');
        }
      } else {
        console.log('WalletInfoCard: ERROR - No wallets returned for user');
      }
    } else {
      console.log('WalletInfoCard: ERROR - No users found for aadObjectId:', account.localAccountId);
    }
  };



  useEffect(() => {
    if (account?.localAccountId) {
      fetchAmountReceived();
    }
  }, [account?.localAccountId]);
  const handleOpenReceivePopup = () => {
    setIsReceivePopupOpen(true);
  };

  const handleCloseReceivePopup = () => {
    setIsReceivePopupOpen(false);
  };

  const handleOpenSendPopup = () => {
    setIsSendPopupOpen(true);
  };

  const handleCloseSendPopup = () => {
    setIsSendPopupOpen(false);
  };

  const rewardNameContext = useContext(RewardNameContext);
  if (!rewardNameContext) {
    return null; // or handle the case where the context is not available
  }
const rewardsName = rewardNameContext.rewardName;

  // Buttons should be disabled if balance is undefined (still loading)
  const isLoading = false; // balance === undefined;

  return (
    <div className="wallet-info">
      <h4>Your wallet</h4>
      <p>Amount received from other users:</p>
      <div className="horizontal-container">
        <div className="item">
          {' '}
          <h1>{balance?.toLocaleString() ?? '0'}</h1>
        </div>
        <div className="item">{rewardsName}</div>
        <div
          className="col-md-1 item"
          style={{ paddingTop: '30px', paddingLeft: '10px' }}
        >
          <button style={{ display: 'none' }} className="refreshImageIcon">
            <img
              src={ArrowClockwise}
              alt="icon"
              style={{ width: 30, height: 30 }}
            />
          </button>
        </div>
      </div>
      <div className="wallet-buttons">
        <div>
          {' '}
          <button
            onClick={handleOpenReceivePopup}
            className="receive-btn"
            disabled={isLoading}
          >
            Receive
          </button>
        </div>
        <div>
          <button
            onClick={handleOpenSendPopup}
            className="send-btn"
            disabled={isLoading}
          >
            Send
          </button>
        </div>
        {isReceivePopupOpen && (
          <div className="overlay" onClick={handleCloseReceivePopup}>
            <div className="popup" onClick={e => e.stopPropagation()}>
              <ReceivePayment
                onClose={handleCloseReceivePopup}
                currentUserLNbitDetails={myLNbitDetails!}
              />
            </div>
          </div>
        )}

        {isSendPopupOpen && (
          <div className="overlay" onClick={handleCloseSendPopup}>
            <div className="popup" onClick={e => e.stopPropagation()}>
              <SendPayment
                onClose={handleCloseSendPopup}
                currentUserLNbitDetails={myLNbitDetails!}
              />
            </div>
          </div>
        )}
        <div className="col-md-6">
          <span></span>
        </div>
      </div>
    </div>
  );
};

export default WalletYourWalletInfoCard;
